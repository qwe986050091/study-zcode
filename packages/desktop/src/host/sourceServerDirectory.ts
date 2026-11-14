/**
 * ============================================================================
 * desktop/host/sourceServerDirectory.ts —— Source / Profile / Workspace 目录
 * ============================================================================
 *
 * 【定位】远程目标的持久化目录层：把 SourceServerRecord、ConnectionProfile
 * 与 workspace history 存在 AppSettings/凭据服务里，并负责首次握手后的
 * identity 迁移与显示名兜底。
 *
 * 【三实体关系】
 *   - Source：一台远端设备（sourceServerId 在握手后 canonical）；
 *   - Profile：一条连接线路（SSH alias / WSL distro / Docker / Server），
 *     可有多条指向同一 Source；
 *   - Workspace：Source 上的工作区历史，按 workspaceKey 记录。
 *
 * 【迁移不变量】
 *   - identity 变化（legacy route → stable `remote:server:*`）必须一次性
 *     改写 profile、workspace history 与 controller 记录；
 *   - 显示名只用于展示，不参与任何 identity 计算；
 *   - SSH alias 只作为首次展示默认值，已存在设备优先保留用户命名。
 *
 * 【写入模型（本文件所有变更的共同前提）】
 *   - 所有写操作都经 enqueue 串行化（writeChain），同一时刻只有一个「读 settings -> 变更 ->
 *     persistSettings」事务，规避 last-write-wins 覆盖；
 *   - 凭据变更与 settings 变更成对执行，settings 写入失败时回滚已改的凭据（见 removeProfile /
 *     removeSourceServer 的 previousCredentials）；
 *   - initialize 只执行一次迁移/修复，失败不缓存 rejected promise，避免一次 IO 故障毒化整个生命周期。
 * ============================================================================
 */
/* eslint-disable max-lines -- Source/Profile/Workspace 三实体迁移与凭据重定向需要保持同一事务编排。 */
// 文件头 · desktop/host/sourceServerDirectory.ts —— Source / Profile / Workspace 目录层
// 职责边界：持久化 SourceServerRecord、ConnectionProfile 与 workspace history；负责握手身份迁移与凭据重定向。
// 不负责：运行态连接、attachment 生命周期、UI 展示决策；这些由 management service / ConnectionManager 承担。
// 事实源：settingService（目录事实）+ credentialService（SSH 凭据）；本类不缓存任何一方的快照。
//
// 不变式（INV）：断言 ｜ 守住它的位置 ｜ 改错后的故障
// INV-01 断言 所有写操作经 enqueue 串行 ｜ 位置 writeChain / enqueue ｜ 改错 并发读改写触发 last-write-wins，丢失别的字段
// INV-02 断言 onDidChange 只在确有持久化写入后触发 ｜ 位置 didPersistInCurrentOperation + persistSettings ｜ 改错 无写入的 no-op 也驱动全部消费方重读快照
// INV-03 断言 initialize 失败不缓存 rejected promise ｜ 位置 initialize 的 catch 清空 initializePromise ｜ 改错 一次 IO 故障毒化整个 Host 生命周期
// INV-04 断言 initialize 与业务写入共用同一队列 ｜ 位置 initialize 内的 enqueue ｜ 改错 启动期迁移与用户操作交错，产生半迁移视图
// INV-05 断言 identity 冲突且未确认时严格零写入 ｜ 位置 recordHandshake 的 identityChanged && !confirmIdentityChange 分支 ｜ 改错 用户确认前就已改绑，无法回退
// INV-06 断言 身份替换必须换新 profileId ｜ 位置 commitIdentityReplacement 的 newProfileId 校验 ｜ 改错 旧代际缓存/成员关系误命中新设备
// INV-07 断言 旧 profile 标 retired 且保留历史 ｜ 位置 commitIdentityReplacement 的 retiredProfile ｜ 改错 历史随新安装被静默改写，无法溯源
// INV-08 断言 settings 写失败必须回滚本次凭据变更 ｜ 位置 ensureProfile / updateProfile / removeProfile / removeSourceServer 的 catch ｜ 改错 留下无人引用的 orphan secret
// INV-09 断言 凭据 key 只由 profileId + kind 派生 ｜ 位置 newCredentialKey ｜ 改错 复用旧 id 的 key 会被另一台设备误读
// INV-10 断言 identity 只由可连字段决定 ｜ 位置 profileTargetIdentityKey ｜ 改错 alias/assetInstallMode 变化被误判成新线路，历史割裂
// INV-11 断言 同一连接身份至多一个 active Profile ｜ 位置 ensureProfile 的 isActiveProfile + targetKey 查找 ｜ 改错 重复 Profile 分流 workspace 历史
// INV-12 断言 deferCredentials=true 绝不读写凭据 ｜ 位置 ensureProfile 的 existing && deferCredentials 分支 ｜ 改错 认证结果未定时覆盖用户凭据
// INV-13 断言 displayName 不参与 identity ｜ 位置 resolveDefaultSourceDisplayName / renameSource / renameProfile ｜ 改错 改名导致线路或设备身份变化
// INV-14 断言 已存在设备优先保留用户命名 ｜ 位置 recordHandshake 的 previousServer?.displayName ｜ 改错 每次握手用 hostname 覆盖用户命名
// INV-15 断言 workspace history 的 legacy identity 一旦冻结不再覆盖 ｜ 位置 recordWorkspaceOpen 的 legacyWorkspaceIdentity 合并 ｜ 改错 重连后读不到旧 key，也读不到 Profile 密码
// INV-16 断言 conversation backing path 不写入 strict project history ｜ 位置 recordWorkspaceOpen 的 workspacePurpose 早返回 + recordConversationWorkspace 过滤 ｜ 改错 会话路径污染项目列表
// INV-17 断言 abort 必须在写入前生效 ｜ 位置 recordWorkspaceOpen 三处 throwIfAborted ｜ 改错 取消后仍落盘 workspace history
// INV-18 断言 preferredProfileId 只指向 active 且同 Source 的 Profile ｜ 位置 removeProfile 重算 / setPreferredProfile 校验 ｜ 改错 首选线路指向已删或别设备 Profile
// INV-19 断言 删除设备必须覆盖只有 legacy profileId 的孤儿 history ｜ 位置 removeSourceServer 的 removedProfileIds 过滤 ｜ 改错 已删 Profile 的条目永久残留
// INV-20 断言 迁移凭据只在真正进入提交集时落 secret ｜ 位置 persistLegacyRemoteEntries 的 shouldMigrateProfiles ｜ 改错 被丢弃的临时 Profile 也造 orphan key
// INV-21 断言 凭据复制两类必须顺序 await ｜ 位置 migrateProfileTarget ｜ 改错 迟到 save 越过 rollback 再落盘
// INV-22 断言 只有复制成功才写 credential 引用 ｜ 位置 copyFirstAvailableCredential 返回值 ｜ 改错 生成指向空值的 Profile ref，阻断完整密码
// INV-23 断言 静默建连允许密码或私钥任一链完整 ｜ 位置 resolveSilentTarget 的 hasPasswordAuth/hasPrivateKeyAuth ｜ 改错 已完整的密码认证被误判为需要交互
// INV-24 断言 设备记录只用设备级 canonical identity ｜ 位置 projectDeclaredWorkspaces 的 identityIsValid ｜ 改错 线路级或跨设备 identity 被写入设备记录
// INV-25 断言 远端 identity 被 canonical 覆盖只记 debug 不报错 ｜ 位置 projectDeclaredWorkspaces 的 logDebug 分支 ｜ 改错 一次不一致的远端上报阻断整次握手
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Emitter, type Event } from "@zcode/rpc";
import {
  buildServerRemoteWorkspaceIdentity,
  isValidWslUser,
  parseRemoteWorkspaceIdentity,
  type AppSettings,
  type ConnectionProfile,
  type DockerProfileTarget,
  type SourceServerRecord,
  type SourceServerWorkspaceHistoryEntry,
  type SSHProfileTarget,
  type WSLProfileTarget,
  type RemoteWorkspaceSessionEntry,
  type RemoteTarget,
  type SourceServerDeclaredWorkspaceWire,
} from "@zcode/shared";
import type {
  ICredentialService,
  ISettingService,
  UpdateConnectionProfileInput,
} from "@zcode/services";
import {
  getDataBaseDir,
  migrateControllerRemoteWorkspaceIdentity,
  type ControllerRemoteIdentityMigrationReport,
} from "@zcode/services/node";

// 目录层依赖：settings 为持久化事实源，credentialService 管 SSH 凭据；
// createProfileId/now 可注入用于测试；migrateControllerIdentity 负责改写 controller 侧
// workspace key（默认落到 tasks-index.sqlite），失败只记入 migrationFailures 不阻断握手。
export interface SourceServerDirectoryOptions {
  settingService: ISettingService;
  credentialService: ICredentialService;
  createProfileId?: () => string;
  now?: () => number;
  migrateControllerIdentity?: (input: {
    oldWorkspaceKey: string;
    newWorkspaceKey: string;
  }) => Promise<ControllerRemoteIdentityMigrationReport>;
  /** 远端 identity 被 canonical 覆盖等非错误诊断信息；生产环境应注入 no-op。 */
  logDebug?: (message: string) => void;
}

// 一次握手的原始事实：sourceServerId 是 canonical 身份，其余字段用于展示名兜底与
// declaredWorkspaces 投影；connectedAt 缺省取 now，避免调用方时钟漂移。
export interface SourceServerHandshakeRecord {
  sourceServerId: string;
  osUser?: string;
  hostname?: string;
  version: string;
  connectedAt?: number;
  workspaces?: readonly SourceServerDeclaredWorkspaceWire[];
}

// 记录握手后的结果。identityChanged=true 且 migrationFailures 非空时，调用方需要提示
// 「已换绑但部分历史迁移失败」；effectiveProfile 是最终生效的 Profile（身份替换后会换 id）。
export interface SourceServerHandshakeResult {
  identityChanged: boolean;
  migrationFailures: string[];
  effectiveProfileId: string;
  effectiveProfile: ConnectionProfile;
}

// [契约] retired 是终态：retired Profile 不参与 identity 匹配、重连候选与首选线路重算。
// [失败路径] 把 retired 当 active 会让换绑后的旧线路被再次选中，连回旧设备。
// [权衡] 只按 lifecycleState 判断，不引入 deletedAt 等第二套墓碑字段。
// [失败路径] 若用 sourceServerId 判活，未识别（尚无 id）的 saved profile 会被误杀。
function isActiveProfile(profile: ConnectionProfile): boolean {
  return profile.lifecycleState !== "retired";
}

// [契约] SSH alias 只作为首次展示默认值，不参与任何 identity 计算。
// [失败路径] 已存在设备会被 hostname 覆盖：调用方必须先取 previousServer.displayName。
// [契约] hostname 与 osUser 都为空时回落 sourceServerId，保证名称非空。
// [失败路径] 直接用 join 结果而不 filter，会产生 " · " 这种只有分隔符的名称。
// [权衡] 展示名可重复，不做唯一性校验，避免重命名被身份规则阻断。
function resolveDefaultSourceDisplayName(
  profile: ConnectionProfile,
  handshake: SourceServerHandshakeRecord,
): string {
  // Bug 原因：SSH alias 已持久化在线路 Profile 中，但设备首次握手只用 hostname/osUser 生成名称，
  // 导致用户精心维护的可读 alias 被随机容器 hostname 覆盖。alias 只作为首次展示默认值，
  // 已存在设备仍由调用方优先保留 displayName，且这里不参与任何 identity 计算。
  const sshAlias =
    profile.target.kind === "ssh" ? profile.target.sshConfigAlias?.trim() : undefined;
  return (
    sshAlias ||
    [handshake.hostname, handshake.osUser]
      .filter((value): value is string => Boolean(value?.trim()))
      .join(" · ") ||
    handshake.sourceServerId
  );
}

// 目录快照的三个只读数组（拷贝返回，调用方修改不影响持久化状态）。
// 读取前会走 initialize，因此迁移/修复未完成时不会返回「半迁移」的视图。
export interface SourceServerDirectorySnapshot {
  profiles: ConnectionProfile[];
  servers: SourceServerRecord[];
  workspaceHistory: SourceServerWorkspaceHistoryEntry[];
}

// 启动重连候选：profile + 已解析（含凭据）的 target；仅 active profile，且排除 server 直连形态
// （server 形态不走 transport adapter，由另一个入口处理）。
export interface SourceServerReconnectCandidate {
  profile: ConnectionProfile;
  target: Exclude<RemoteTarget, { kind: "server" }>;
}

type LegacySourceWorkspaceEntry = RemoteWorkspaceSessionEntry & {
  target: Exclude<RemoteWorkspaceSessionEntry["target"], { kind: "server" }>;
};

// [契约] routeKey 是 legacy 会话条目的连接路由指纹，字段顺序与分隔符不可改。
// [失败路径] 改变字段集合会让历史条目的 key 全部失配，迁移后查不到凭据。
// [契约] host 与 distro 统一 toLowerCase，port 缺省 22，保证同路由同 key。
// [失败路径] 不做 trim/lowercase 会让大小写差异产生两条 route，重复迁移。
// [契约] server 直连形态返回 null：它不支持凭据迁移，调用方必须跳过。
function routeKey(
  entry: Extract<NonNullable<AppSettings["lastWorkspaceSession"]>[number], { kind: "remote" }>,
): string | null {
  const target = entry.target;
  switch (target.kind) {
    case "ssh":
      return [
        "ssh",
        target.host.trim().toLowerCase(),
        String(target.port ?? 22),
        target.username.trim(),
        target.privateKeyPath?.trim() ?? "",
      ].join("\u0000");
    case "wsl":
      return [
        "wsl",
        target.distro?.trim().toLowerCase() ?? "default",
        target.user?.trim().toLowerCase() ?? "",
      ].join("\u0000");
    case "docker":
      return ["docker", target.container.trim()].join("\u0000");
    case "server":
      return null;
  }
}

// [契约] identity 只包含可连字段；assetInstallMode/alias/resourcePackages 不参与。
// [失败路径] 把 alias 计入 key，会让用户改别名时被判定成新线路，历史割裂。
// [契约] SSH 的 port 缺省 22、host 小写、key 路径 trim 后比较。
// [失败路径] 不做规范化会让同一台机器因书写差异产生两个 Profile。
// [契约] WSL 的 distro/user 用 trim 值而非小写，distro 名本身区分大小写。
function profileTargetIdentityKey(
  target: SSHProfileTarget | WSLProfileTarget | DockerProfileTarget,
): string {
  switch (target.kind) {
    case "ssh":
      // assetInstallMode、alias 和 resourcePackages 只影响部署/展示，不是连接身份。
      return JSON.stringify({
        kind: "ssh",
        host: target.host.trim().toLowerCase(),
        port: target.port ?? 22,
        username: target.username.trim(),
        privateKeyPath: target.privateKeyPath?.trim() ?? "",
      });
    case "wsl":
      return JSON.stringify({
        kind: "wsl",
        distro: target.distro?.trim() ?? "",
        user: target.user?.trim() ?? "",
      });
    case "docker":
      return JSON.stringify({ kind: "docker", container: target.container.trim() });
  }
}

// [契约] key 只由 profileId + kind 决定，保证同一 Profile 的凭据槽位稳定。
// [失败路径] 若把 host 等可变字段拼进 key，改地址后旧凭据成为永久孤儿。
// [权衡] 两个 kind 共用前缀，便于删除设备时按 profileId 批量清理。
// [契约] 该函数是凭据 key 的唯一构造点，其它地方不得手写字符串前缀。
function newCredentialKey(profileId: string, kind: "password" | "private-key-passphrase"): string {
  return `connection-profile:${profileId}:${kind}`;
}

// Source/Profile/Workspace 的唯一持久化事务入口。
// 不变量：所有写操作经 enqueue 串行；onDidChange 只在「本次操作确实写入成功」后触发；
// initialize 的迁移/凭据修复与业务写入共用同一队列，保证启动期不会与用户操作交错。
// 失败语义：所有方法把错误原样抛给调用方；凭据回滚是尽力而为（restoreCredentials 失败会 warn）。
// 副作用：读写 settingService 与 credentialService，并发 onDidChange 通知上层重算快照。
export class SourceServerDirectory {
  private readonly createProfileId: () => string;
  private readonly now: () => number;
  private initializePromise: Promise<void> | null = null;
  private writeChain = Promise.resolve();
  private readonly changeEmitter = new Emitter<void>();
  /** 当前 enqueue 操作内是否发生过成功的持久化写入；enqueue 串行执行，实例字段无并发窗口。 */
  private didPersistInCurrentOperation = false;
  private readonly migrateControllerIdentity: NonNullable<
    SourceServerDirectoryOptions["migrateControllerIdentity"]
  >;

  public constructor(private readonly options: SourceServerDirectoryOptions) {
    this.createProfileId = options.createProfileId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.migrateControllerIdentity =
      options.migrateControllerIdentity ??
      (async (input) =>
        await migrateControllerRemoteWorkspaceIdentity({
          dbPath: join(getDataBaseDir(), ".zcode", "v2", "tasks-index.sqlite"),
          ...input,
        }));
  }

  /** 目录持久化成功后的统一变更通知，管理服务负责将其映射为 generation。 */
  public readonly onDidChange: Event<void> = this.changeEmitter.event;

  // 幂等初始化：只跑一次「legacy 迁移 + 悬空凭据修复」，并发调用共享同一 flight。
  // 失败语义：失败时清空缓存的 promise 并重抛，让下一次调用可以重试（见下方 Bug 注释）。
  // [并发] 并发调用共享同一 flight：initializePromise 只在首次创建并赋值。
  // [失败路径] 失败时必须比较 initializePromise === flight 再清空，避免清掉别的重试。
  // [契约] 迁移版本号是唯一开关：sourceServerDirectoryMigrationVersion !== 1 才迁移。
  // [失败路径] 迁移后必须重新 get()，否则后续修复读到的是迁移前的旧快照。
  // [契约] 悬空凭据修复由 repairDanglingProfileCredentials 承担，失败不阻断初始化。
  // [事务] 迁移与修复都在同一 enqueue 内，启动期不会与用户写入交错。
  public async initialize(): Promise<void> {
    if (!this.initializePromise) {
      const flight = this.enqueue(async () => {
        let settings = await this.options.settingService.get();
        if (settings.sourceServerDirectoryMigrationVersion !== 1) {
          await this.migrateLegacyRemoteEntries(settings);
          settings = await this.options.settingService.get();
        }
        await this.repairDanglingProfileCredentials(settings);
      });
      // [并发] 赋值与首次创建之间没有 await，不存在两个 flight 同时存在的窗口。
      // [失败路径] 若在 await flight 之后才赋值，并发调用会各自启动一次迁移。
      // [契约] 清空时必须比较引用相等，避免清掉后来重试创建的 promise。
      this.initializePromise = flight;
    }
    const flight = this.initializePromise;
    try {
      await flight;
    } catch (error) {
      // Bug 原因：失败 flight 若永久缓存，临时 settings/credential IO 故障会让本 Host
      // 生命周期内所有 Source Server 操作持续复用同一个 rejected promise。
      if (this.initializePromise === flight) this.initializePromise = null;
      throw error;
    }
  }

  // 读取三实体快照（拷贝数组）；会先完成 initialize。
  // 返回的是「持久化事实」，不含运行态连接信息（那部分由 ConnectionManager 合并）。
  // [契约] 返回三个数组的浅拷贝，调用方修改不影响持久化状态。
  // [失败路径] 直接返回 settings 上的数组会让外部 push 污染下一次读取。
  // [契约] 先 await initialize，保证不会返回半迁移视图。
  // [契约] 只含持久化事实，运行态连接信息由 ConnectionManager 合并。
  public async snapshot(): Promise<SourceServerDirectorySnapshot> {
    await this.initialize();
    const settings = await this.options.settingService.get();
    return {
      profiles: [...(settings.connectionProfiles ?? [])],
      servers: [...(settings.sourceServers ?? [])],
      workspaceHistory: [...(settings.sourceServerWorkspaceHistory ?? [])],
    };
  }

  // 解析历史 workspace 的 legacy identity：优先命中 (profileId, workspacePath) 的历史记录，
  // 否则回退到调用方给的 fallback。Host 是这一优先级的权威（见 Bug 注释），UI 不得覆盖。
  // [契约] 优先级：历史命中 (profileId, workspacePath) → 调用方 fallback。
  // [失败路径] 让 UI 的 route hint 覆盖历史，会让旧 alias 行丢失时命中不到更精确的 key。
  // [契约] 命中值必须 trim 后才使用，空字符串视为未命中。
  // [失败路径] 返回空串会把「无历史」伪装成「有 identity」，下游拼出非法 key。
  // [权衡] 该优先级只在 Host 侧维护，UI 不得自行决定。
  public async resolveLegacyWorkspaceIdentity(input: {
    profileId: string;
    workspacePath: string;
    fallback: string;
  }): Promise<string> {
    await this.initialize();
    const settings = await this.options.settingService.get();
    const historical = (settings.sourceServerWorkspaceHistory ?? []).find(
      (entry) => entry.profileId === input.profileId && entry.workspacePath === input.workspacePath,
    )?.legacyWorkspaceIdentity;
    // Bug 原因：Renderer stable identity 曾覆盖当前 route hint，导致旧 alias 行丢失时无法命中
    // 更精确的历史 key。legacy hint 的优先级属于 Host Directory 权威，不允许 UI 决定。
    return historical?.trim() || input.fallback;
  }

  // 按「连接身份」查找或创建 Profile：identity 只由 target 的 host/port/user/key 等可连字段决定，
  // assetInstallMode/alias 等部署/展示字段不参与匹配（见 profileTargetIdentityKey）。
  // 输入：target 与 { deferCredentials }；deferCredentials=true 时绝不读取/写入凭据（认证结果未定时）。
  // 输出：现有的或新建的 ConnectionProfile。
  // 副作用：可能写凭据与 settings；settings 写失败会回滚本次凭据变更。
  // 不变量：同一连接身份至多一个 active Profile；已存在时只更新 target 的凭据引用，不重写其它字段。
  // [契约] 先按连接身份找 active Profile，再决定更新还是新建。
  // [失败路径] 不比较 targetKey 直接按 transport 命中，会把不同主机合并成一条线路。
  // [契约] deferCredentials=true 时直接返回 existing，不读不写凭据。
  // [失败路径] 在线 Source 可能跳过认证，此时覆盖凭据会破坏用户已保存的口令。
  // [契约] 既有 Profile 只更新凭据引用，不重写 displayName/createdAt 等字段。
  // [事务] settings 写失败必须 rollback 本次凭据变更，否则留下无主的 secret。
  public async ensureProfile(
    target: Exclude<RemoteTarget, { kind: "server" }>,
    options: { deferCredentials?: boolean } = {},
  ): Promise<ConnectionProfile> {
    await this.initialize();
    return await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const normalizedTarget = this.profileTargetFromRemote(target);
      const targetKey = profileTargetIdentityKey(normalizedTarget);
      const existing = (settings.connectionProfiles ?? []).find(
        (profile) =>
          isActiveProfile(profile) &&
          profile.transport === target.kind &&
          profileTargetIdentityKey(profile.target) === targetKey,
      );
      // 连接结果尚未确定时不能覆盖凭据；在线 Source 可能完全跳过本次认证。
      if (existing && options.deferCredentials) return existing;
      if (existing) {
        const credentialMutation = await this.persistProfileCredentials(
          existing.profileId,
          target,
          existing.target,
        );
        const nextTarget =
          normalizedTarget.kind === "ssh" && credentialMutation.target.kind === "ssh"
            ? {
                ...normalizedTarget,
                ...(credentialMutation.target.passwordCredentialKey
                  ? {
                      passwordCredentialKey: credentialMutation.target.passwordCredentialKey,
                    }
                  : {}),
                ...(normalizedTarget.privateKeyPath &&
                credentialMutation.target.privateKeyPassphraseCredentialKey
                  ? {
                      privateKeyPassphraseCredentialKey:
                        credentialMutation.target.privateKeyPassphraseCredentialKey,
                    }
                  : {}),
              }
            : credentialMutation.target;
        if (JSON.stringify(nextTarget) === JSON.stringify(existing.target)) {
          return existing;
        }
        const updated = {
          ...existing,
          target: nextTarget,
        } as ConnectionProfile;
        try {
          await this.persistSettings({
            connectionProfiles: (settings.connectionProfiles ?? []).map((profile) =>
              profile.profileId === existing.profileId ? updated : profile,
            ),
          });
          return updated;
        } catch (error) {
          await credentialMutation.rollback();
          throw error;
        }
      }
      const profileId = this.createProfileId();
      const credentialMutation = options.deferCredentials
        ? { target: normalizedTarget, rollback: async () => undefined }
        : await this.persistProfileCredentials(profileId, target, normalizedTarget);
      const profile = {
        profileId,
        transport: target.kind,
        target: credentialMutation.target,
        displayName:
          normalizedTarget.kind === "ssh"
            ? (normalizedTarget.sshConfigAlias ?? normalizedTarget.host)
            : normalizedTarget.kind === "wsl"
              ? (normalizedTarget.distro ?? "WSL")
              : normalizedTarget.container,
        createdAt: this.now(),
      } as ConnectionProfile;
      try {
        await this.persistSettings({
          connectionProfiles: [...(settings.connectionProfiles ?? []), profile],
        });
        return profile;
      } catch (error) {
        await credentialMutation.rollback();
        throw error;
      }
    });
  }

  // 计算启动重连候选：Source 按 lastOnlineAt 倒序（最近活动优先），每个 Source 只取一个
  // preferred/最后连接的有效 Profile；再追加「尚无 sourceServerId 的 saved profile」。
  // 失败语义：解析凭据失败（resolveSilentTarget 返回 undefined）时跳过该候选，不影响其它 Source。
  // 副作用：只读 settings 与凭据，不写；不做成员关系过滤（由 Host SQLite 成员表负责）。
  // [契约] Source 按 lastOnlineAt 倒序，最近活动的设备优先占并发槽位。
  // [失败路径] 按首次发现顺序会让旧设备占满 worker，活跃 workspace 反而超时。
  // [契约] 每个 Source 只取一个 Profile：preferred 优先，其次 lastConnectedAt 最新。
  // [失败路径] 不做 break 会让同一 Source 产生多个候选，重复建连。
  // [契约] 尚无 sourceServerId 的 saved profile 追加在末尾，不因七天未用失去资格。
  // [失败路径] 解析凭据失败（resolveSilentTarget 返回 null）时跳过该候选，不影响其它 Source。
  public async listStartupReconnectCandidates(): Promise<SourceServerReconnectCandidate[]> {
    const snapshot = await this.snapshot();
    const candidates: SourceServerReconnectCandidate[] = [];
    // Bug 原因：Directory 数组按 Source 首次发现顺序持久化。冷启动 worker 有并发上限时，
    // 旧 Source 会先占满槽位，最近活动 workspace 的 Source 反而可能排到后面并超时。
    // 候选队列以最近在线事实排序；单个 Source 内仍由 preferred Profile 决定连接路由。
    // 保存的连接不因七天未使用失去启动重连资格；凭据和全局关闭开关继续由原入口守卫。
    const serversByRecentActivity = [...snapshot.servers].sort(
      (left, right) => (right.lastOnlineAt ?? 0) - (left.lastOnlineAt ?? 0),
    );
    for (const server of serversByRecentActivity) {
      const profiles = snapshot.profiles
        .filter(
          (profile) => isActiveProfile(profile) && profile.sourceServerId === server.sourceServerId,
        )
        .sort((left, right) => {
          if (left.profileId === server.preferredProfileId) return -1;
          if (right.profileId === server.preferredProfileId) return 1;
          return (right.lastConnectedAt ?? 0) - (left.lastConnectedAt ?? 0);
        });
      for (const profile of profiles) {
        const target = await this.resolveSilentTarget(profile);
        if (!target) continue;
        candidates.push({ profile, target });
        break;
      }
    }
    // 首次握手失败的已保存 Profile 仍是有效连接；是否保留由 Host 的 SQLite 成员表筛选。
    for (const profile of snapshot.profiles) {
      if (!isActiveProfile(profile) || profile.sourceServerId) continue;
      const target = await this.resolveSilentTarget(profile);
      if (target) candidates.push({ profile, target });
    }
    return candidates;
  }

  // 幂等推进「最近在线时刻」：只对已存在的 Source 且时间严格更大时写入，绝不倒退/复活记录。
  // 这保证断线事件晚于重连握手或删除时不会污染目录（见下方注释）。
  // [契约] 只对已存在的 Source 且时间严格更大时写入，绝不倒退。
  // [失败路径] 断线事件晚于重连握手时，倒退会污染最近在线排序。
  // [契约] 不存在时直接 return：不复活已删除的设备记录。
  // [失败路径] upsert 会给已删设备凭空重建一条记录。
  // [契约] 相等时间也不写，避免无意义的 settings 写入与变更事件。
  public async recordLastOnline(sourceServerId: string, timestamp: number): Promise<void> {
    await this.initialize();
    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const server = settings.sourceServers?.find(
        (entry) => entry.sourceServerId === sourceServerId,
      );
      // 断线事件可能晚于重连握手或删除；只推进已存在设备的时间，不能倒退或复活记录。
      if (!server || timestamp <= (server.lastOnlineAt ?? 0)) return;
      await this.persistSettings({
        sourceServers: settings.sourceServers!.map((entry) =>
          entry === server ? { ...entry, lastOnlineAt: timestamp } : entry,
        ),
      });
    });
  }

  // 写入握手事实：更新 profile 的 sourceServerId/lastConnectedAt、upsert Source 记录、
  // 回填 workspace history 的 stable identity，并对每条 legacy key 触发 controller 迁移。
  // 身份冲突语义：若握手 sourceServerId 与既有不同且未确认，则「严格零写入」直接返回 pending
  //   （identityChanged=true），把决策交回 UI；确认后才走 commitIdentityReplacement（换新 profileId）。
  // 失败语义：未知/已 retired 的 profile 抛错；迁移失败只记录到 migrationFailures，不阻止握手。
  // 副作用：写 settings（可能多次），并可能改写 controller 的 tasks-index；原生事件由设置层统一发出。
  // [契约] 未知或 retired Profile 直接抛错，不允许握手复活 retired 线路。
  // [失败路径] identityChanged 未确认时必须严格零写入后返回 pending。
  // [契约] 未换绑路径更新 sourceServerId/lastConnectedAt/lastConnectError/lifecycleState。
  // [失败路径] 忘记清 lastConnectError 会让 UI 一直显示上次失败原因。
  // [契约] declaredWorkspaces 由 projectDeclaredWorkspaces 统一做 canonical 化。
  // [并发] 整个握手在 enqueue 内完成，避免与删除/改名交错。
  public async recordHandshake(
    profileId: string,
    handshake: SourceServerHandshakeRecord,
    options: { confirmIdentityChange?: boolean } = {},
  ): Promise<SourceServerHandshakeResult> {
    await this.initialize();
    return await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const profiles = [...(settings.connectionProfiles ?? [])];
      const profileIndex = profiles.findIndex((profile) => profile.profileId === profileId);
      if (profileIndex < 0) throw new Error(`Unknown Connection Profile: ${profileId}`);
      const connectedAt = handshake.connectedAt ?? this.now();
      const currentProfile = profiles[profileIndex]!;
      if (!isActiveProfile(currentProfile)) {
        throw new Error(`Connection Profile is retired: ${profileId}`);
      }
      const previousSourceServerId = currentProfile.sourceServerId;
      const identityChanged =
        Boolean(previousSourceServerId) && previousSourceServerId !== handshake.sourceServerId;
      // [失败路径] pending 阶段必须严格零写入：不写 settings、不碰凭据。
      // [契约] 返回 identityChanged=true 与旧 effectiveProfile，让 UI 决定是否换绑。
      // [失败路径] 先改绑再返回，用户确认已经来不及，且无法回滚。
      // [契约] migrationFailures 在 pending 阶段恒为空：还没开始迁移。
      // [并发] 该分支在 enqueue 内返回，不会与其它写入交错。
      if (identityChanged && options.confirmIdentityChange !== true) {
        // Bug 根因：旧实现先改绑 Profile/history，再把 identityChanged 返回给上层，用户确认
        // 已经来不及。pending 阶段必须严格零写入。
        return {
          identityChanged: true,
          migrationFailures: [],
          effectiveProfileId: profileId,
          effectiveProfile: currentProfile,
        };
      }
      if (identityChanged) {
        return await this.commitIdentityReplacement({
          settings,
          currentProfile,
          handshake,
          connectedAt,
        });
      }
      profiles[profileIndex] = {
        ...currentProfile,
        sourceServerId: handshake.sourceServerId,
        lastConnectedAt: connectedAt,
        lastConnectError: undefined,
        lifecycleState: "active",
      } as ConnectionProfile;

      const servers = [...(settings.sourceServers ?? [])];
      const serverIndex = servers.findIndex(
        (server) => server.sourceServerId === handshake.sourceServerId,
      );
      const defaultDisplayName = resolveDefaultSourceDisplayName(currentProfile, handshake);
      const previousServer = serverIndex >= 0 ? servers[serverIndex] : undefined;
      const nextServer: SourceServerRecord = {
        sourceServerId: handshake.sourceServerId,
        displayName: previousServer?.displayName ?? defaultDisplayName,
        ...(handshake.osUser ? { osUser: handshake.osUser } : {}),
        ...(handshake.hostname ? { hostname: handshake.hostname } : {}),
        lastSeenVersion: handshake.version,
        lastOnlineAt: connectedAt,
        preferredProfileId: previousServer?.preferredProfileId ?? profileId,
        installState: "installed",
        declaredWorkspaces: projectDeclaredWorkspaces(
          handshake.sourceServerId,
          handshake.workspaces ?? [],
          this.options.logDebug,
        ),
      };
      if (serverIndex >= 0) servers[serverIndex] = nextServer;
      else servers.push(nextServer);

      const workspaceHistory = (settings.sourceServerWorkspaceHistory ?? []).map((entry) =>
        entry.profileId === profileId
          ? {
              ...entry,
              sourceServerId: handshake.sourceServerId,
              workspaceIdentity: buildServerRemoteWorkspaceIdentity({
                serverId: handshake.sourceServerId,
                workspacePath: entry.workspacePath,
              }),
            }
          : entry,
      );
      // [契约] controller workspace key 迁移失败只收集到数组，不中断握手。
      // [失败路径] 失败即抛会让一次 tasks-index 写失败阻断整个设备握手。
      // [契约] 只迁移 legacyWorkspaceIdentity 与新 identity 不同的条目。
      // [失败路径] 相同 key 也迁移会重复写 controller，产生无意义 IO。
      // [契约] 收集的是 workspacePath 或 report.error，供 UI 提示部分失败。
      const migrationFailures: string[] = [];
      for (const entry of workspaceHistory) {
        if (
          entry.profileId !== profileId ||
          !entry.legacyWorkspaceIdentity ||
          !entry.workspaceIdentity ||
          entry.legacyWorkspaceIdentity === entry.workspaceIdentity
        ) {
          continue;
        }
        const report = await this.migrateControllerIdentity({
          oldWorkspaceKey: entry.legacyWorkspaceIdentity,
          newWorkspaceKey: entry.workspaceIdentity,
        });
        if (report.status === "failed") {
          migrationFailures.push(report.error ?? entry.workspacePath);
        }
      }
      await this.persistSettings({
        connectionProfiles: profiles,
        sourceServers: servers,
        sourceServerWorkspaceHistory: workspaceHistory,
      });
      return {
        identityChanged: false,
        migrationFailures,
        effectiveProfileId: profileId,
        effectiveProfile: profiles[profileIndex]!,
      };
    });
  }

  // 记录一次「打开远端 workspace」到 strict project history。
  // 输入：profile/source/path/identity，可带 legacyWorkspaceIdentity 与 abort signal。
  // 特例：workspacePurpose="conversation" 直接返回——conversation backing path 只能写
  //   remoteConversationWorkspaceBySourceServerId，不能污染 strict history。
  // 失败语义：abort 时在写入前抛 AbortError；不吞任何错误。
  // 副作用：按 (sourceServerId, workspacePath) upsert，保留冻结的 legacy identity。
  // [契约] conversation backing path 直接早返回，不写 strict project history。
  // [失败路径] 写进去会让会话目录出现在项目列表里。
  // [契约] abort 检查在入队前、入队后、持久化前各一次。
  // [失败路径] 只在最外层检查，会让排队期间被取消的操作仍然落盘。
  // [契约] 按 (sourceServerId, workspacePath) upsert，其它设备同路径不动。
  // [失败路径] 只按 workspacePath 匹配会跨设备互相覆盖历史。
  public async recordWorkspaceOpen(input: {
    profileId: string;
    sourceServerId: string;
    workspacePath: string;
    workspaceIdentity: string;
    workspacePurpose?: "project" | "conversation";
    legacyWorkspaceIdentity?: string;
    openedAt?: number;
    signal?: AbortSignal;
  }): Promise<void> {
    input.signal?.throwIfAborted();
    if (input.workspacePurpose === "conversation") {
      // conversation backing workspace 只属于设备级 canonical path，不得污染 strict project history。
      return;
    }
    await this.initialize();
    input.signal?.throwIfAborted();
    await this.enqueue(async () => {
      input.signal?.throwIfAborted();
      const settings = await this.options.settingService.get();
      input.signal?.throwIfAborted();
      const history = [...(settings.sourceServerWorkspaceHistory ?? [])];
      const index = history.findIndex(
        (entry) =>
          entry.sourceServerId === input.sourceServerId &&
          entry.workspacePath === input.workspacePath,
      );
      const existing = index >= 0 ? history[index] : undefined;
      const legacyWorkspaceIdentity =
        input.legacyWorkspaceIdentity?.trim() || existing?.legacyWorkspaceIdentity?.trim();
      const next: SourceServerWorkspaceHistoryEntry = {
        workspacePath: input.workspacePath,
        workspaceIdentity: input.workspaceIdentity,
        // Bug 原因：stable identity 重连不会再次携带 route hint；整行覆盖会抹掉冻结的
        // legacy identity，下一次启动无法投影 stable key，也读不到 Profile 密码。
        ...(legacyWorkspaceIdentity ? { legacyWorkspaceIdentity } : {}),
        profileId: input.profileId,
        sourceServerId: input.sourceServerId,
        lastOpenedAt: input.openedAt ?? this.now(),
      };
      if (index >= 0) history[index] = next;
      else history.push(next);
      // 同一 JS turn 内从最后一次 abort 检查直接发起持久化，不再引入 await 窗口；取消
      // 若发生在前一段异步读取期间，会在这里阻止任何 workspace history 写入。
      input.signal?.throwIfAborted();
      await this.persistSettings({
        sourceServerWorkspaceHistory: history,
      });
    });
  }

  // 记录「当前会话工作区」的 canonical 路径，并在同一写事务里清掉同 Source/path 的
  // strict history 污染项（见 Bug 注释），其它设备/其它路径不动。
  // 失败语义：空参数抛错；写入失败原样上抛。
  // [契约] 同一写事务内写 canonical conversation path 并清理同 Source/path 的 strict 污染项。
  // [失败路径] 分两次写会留下「既是项目又是会话」的中间态。
  // [契约] 只删同 sourceServerId 且同 workspacePath 的条目。
  // [失败路径] 只按 path 过滤会误删其它设备的同名目录。
  // [契约] 空 sourceServerId 或空 path 直接抛错，不做静默补齐。
  // [契约] lastResolvedAt 取 this.now()，便于诊断而不参与比较。
  public async recordConversationWorkspace(
    sourceServerId: string,
    workspacePath: string,
  ): Promise<void> {
    const normalizedPath = workspacePath.trim();
    if (!sourceServerId.trim() || !normalizedPath) {
      throw new Error("Source conversation workspace requires sourceServerId and workspacePath");
    }
    await this.initialize();
    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const current = settings.remoteConversationWorkspaceBySourceServerId ?? {};
      // Bug 原因：旧流程可能先把 backing path 当普通 project 写入 strict history。
      // canonical conversation 一旦确认，必须在同一 Directory 写事务中清掉同 Source/path
      // 的污染项；其它设备的同路径与同设备真实项目都保留。
      const projectHistory = (settings.sourceServerWorkspaceHistory ?? []).filter(
        (entry) =>
          entry.sourceServerId !== sourceServerId || entry.workspacePath !== normalizedPath,
      );
      await this.persistSettings({
        remoteConversationWorkspaceBySourceServerId: {
          ...current,
          [sourceServerId]: {
            workspacePath: normalizedPath,
            lastResolvedAt: this.now(),
          },
        },
        sourceServerWorkspaceHistory: projectHistory,
      });
    });
  }

  // 重命名设备：只改 displayName（不参与 identity）；空名或未知 Source 抛错。
  // [契约] 只改 displayName，不参与 identity、不触发任何凭据操作。
  // [失败路径] 若顺带改写 slug/identity，会让历史绑定失效。
  // [契约] 空名抛错在入队前完成，避免占用写队列。
  // [失败路径] 未知 Source 抛错而不是 upsert，防止凭空造设备。
  public async renameSource(sourceServerId: string, displayName: string): Promise<void> {
    await this.initialize();
    const normalized = displayName.trim();
    if (!normalized) throw new Error("Source Server display name is required");
    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const servers = [...(settings.sourceServers ?? [])];
      const index = servers.findIndex((server) => server.sourceServerId === sourceServerId);
      if (index < 0) throw new Error(`Unknown Source Server: ${sourceServerId}`);
      servers[index] = { ...servers[index]!, displayName: normalized };
      await this.persistSettings({ sourceServers: servers });
    });
  }

  // 重命名线路：只改 profile.displayName；空名或未知 profile 抛错。
  public async renameProfile(profileId: string, displayName: string): Promise<void> {
    await this.initialize();
    const normalized = displayName.trim();
    if (!normalized) throw new Error("Connection Profile display name is required");
    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const profiles = [...(settings.connectionProfiles ?? [])];
      const index = profiles.findIndex((profile) => profile.profileId === profileId);
      if (index < 0) throw new Error(`Unknown Connection Profile: ${profileId}`);
      profiles[index] = {
        ...profiles[index]!,
        displayName: normalized,
      } as ConnectionProfile;
      await this.persistSettings({
        connectionProfiles: profiles,
      });
    });
  }

  // 组合更新：同时改 profile 与 Source 的展示名，以及 profile 的连接目标（改址会重定向凭据）。
  // 校验在前（空名/非法 sourceDisplayName 直接抛），校验通过后才进入串行写事务。
  // 副作用：可能迁移凭据（旧 key -> 新 key），settings 写失败会回滚凭据。
  // [契约] 校验（空名、transport 不可变、SSH/WSL/Docker 字段）全部在入队前完成。
  // [失败路径] 放到事务里校验会在失败时留下已改的凭据。
  // [契约] 原位更新 Profile，profileId/sourceServerId/history 全部保持稳定。
  // [失败路径] 改成新建 Profile 会把同一 Source 的 workspace/task 历史割裂。
  // [契约] 认证方式切换必须删除另一侧的凭据引用，避免双份凭据并存。
  // [事务] 凭据与 settings 在同一回滚边界内，失败时 restoreCredentials 逐步还原。
  public async updateProfile(input: UpdateConnectionProfileInput): Promise<void> {
    await this.initialize();
    const profileDisplayName = input.profileDisplayName.trim();
    const sourceDisplayName = input.sourceDisplayName?.trim();
    if (!profileDisplayName) {
      throw new Error("Connection Profile display name is required");
    }
    if (input.sourceDisplayName !== undefined && !sourceDisplayName) {
      throw new Error("Source Server display name is required");
    }

    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const profiles = [...(settings.connectionProfiles ?? [])];
      const profileIndex = profiles.findIndex((profile) => profile.profileId === input.profileId);
      if (profileIndex < 0) {
        throw new Error(`Unknown Connection Profile: ${input.profileId}`);
      }
      const currentProfile = profiles[profileIndex]!;
      if (!isActiveProfile(currentProfile)) {
        throw new Error(`Connection Profile is retired: ${input.profileId}`);
      }
      if (currentProfile.transport !== input.target.kind) {
        throw new Error("Connection Profile transport cannot be changed");
      }

      // [契约] 校验基于归一化后的 target，而不是入参原始字段。
      // [失败路径] 直接校验原始值会放过 host 只有空白的输入。
      // [契约] SSH 校验 host/username/port 范围 1..65535 且必须是整数。
      // [失败路径] 允许非整数端口会把非法值写进 settings，连接时才发现。
      // [契约] 校验失败在凭据操作之前完成，避免先改后回滚。
      const normalizedTarget = this.profileTargetFromRemote(input.target);
      if (
        normalizedTarget.kind === "ssh" &&
        (!normalizedTarget.host ||
          !normalizedTarget.username ||
          normalizedTarget.port === undefined ||
          !Number.isInteger(normalizedTarget.port) ||
          normalizedTarget.port <= 0 ||
          normalizedTarget.port > 65_535)
      ) {
        throw new Error("SSH connection details are invalid");
      }
      if (
        normalizedTarget.kind === "wsl" &&
        normalizedTarget.user &&
        !isValidWslUser(normalizedTarget.user)
      ) {
        throw new Error("WSL user is invalid");
      }
      if (normalizedTarget.kind === "docker" && !normalizedTarget.container) {
        throw new Error("Docker container is required");
      }
      const previousCredentials = new Map<string, string | null>();
      const rememberCredential = async (key: string) => {
        if (previousCredentials.has(key)) return;
        previousCredentials.set(key, await this.options.credentialService.load(key));
      };
      const saveCredential = async (key: string, value: string) => {
        await rememberCredential(key);
        await this.options.credentialService.save(key, value);
      };
      const deleteCredential = async (key?: string) => {
        if (!key) return;
        await rememberCredential(key);
        await this.options.credentialService.delete(key);
      };

      let nextTarget = normalizedTarget;
      try {
        if (
          currentProfile.target.kind === "ssh" &&
          normalizedTarget.kind === "ssh" &&
          input.target.kind === "ssh"
        ) {
          if (!input.sshAuthMethod) {
            throw new Error("SSH authentication method is required");
          }
          if (input.sshAuthMethod === "password") {
            const { privateKeyPath: _privateKeyPath, ...passwordTarget } = normalizedTarget;
            const passwordCredentialKey =
              currentProfile.target.passwordCredentialKey ??
              newCredentialKey(input.profileId, "password");
            const password = input.target.password?.trim();
            const savedPassword = currentProfile.target.passwordCredentialKey
              ? await this.options.credentialService.load(
                  currentProfile.target.passwordCredentialKey,
                )
              : null;
            if (!password && !savedPassword) {
              throw new Error("SSH password is required");
            }
            if (password) {
              await saveCredential(passwordCredentialKey, password);
            }
            await deleteCredential(currentProfile.target.privateKeyPassphraseCredentialKey);
            nextTarget = {
              ...passwordTarget,
              passwordCredentialKey,
            } as SSHProfileTarget;
          } else {
            if (!normalizedTarget.privateKeyPath?.trim()) {
              throw new Error("SSH private key path is required");
            }
            await deleteCredential(currentProfile.target.passwordCredentialKey);
            let privateKeyPassphraseCredentialKey: string | undefined;
            const privateKeyPassphrase = input.target.privateKeyPassphrase?.trim();
            if (privateKeyPassphrase) {
              privateKeyPassphraseCredentialKey =
                currentProfile.target.privateKeyPassphraseCredentialKey ??
                newCredentialKey(input.profileId, "private-key-passphrase");
              await saveCredential(privateKeyPassphraseCredentialKey, privateKeyPassphrase);
            } else if (
              currentProfile.target.privateKeyPath === normalizedTarget.privateKeyPath &&
              currentProfile.target.privateKeyPassphraseCredentialKey
            ) {
              privateKeyPassphraseCredentialKey =
                currentProfile.target.privateKeyPassphraseCredentialKey;
            } else {
              await deleteCredential(currentProfile.target.privateKeyPassphraseCredentialKey);
            }
            nextTarget = {
              ...normalizedTarget,
              ...(privateKeyPassphraseCredentialKey ? { privateKeyPassphraseCredentialKey } : {}),
            } as SSHProfileTarget;
          }
        }

        profiles[profileIndex] = {
          ...currentProfile,
          displayName: profileDisplayName,
          target: nextTarget,
          lastConnectError: undefined,
        } as ConnectionProfile;

        let servers = settings.sourceServers;
        if (sourceDisplayName !== undefined) {
          if (!currentProfile.sourceServerId) {
            throw new Error("Unidentified Connection Profile cannot rename a Source Server");
          }
          servers = [...(settings.sourceServers ?? [])];
          const serverIndex = servers.findIndex(
            (server) => server.sourceServerId === currentProfile.sourceServerId,
          );
          if (serverIndex < 0) {
            throw new Error(`Unknown Source Server: ${currentProfile.sourceServerId}`);
          }
          servers[serverIndex] = {
            ...servers[serverIndex]!,
            displayName: sourceDisplayName,
          };
        }

        // 根因：旧管理面只能改线路别名，用户修改地址时只能新建 Profile，进而把同一
        // Source 的 workspace/task 历史割裂。这里原位更新 Profile，并把凭据与 settings
        // 放在同一回滚边界内，确保 profileId/sourceServerId/history 全部保持稳定。
        await this.persistSettings({
          connectionProfiles: profiles,
          ...(servers ? { sourceServers: servers } : {}),
        });
      } catch (error) {
        await this.restoreCredentials(previousCredentials);
        throw error;
      }
    });
  }

  // 设置 Source 的首选线路：profile 必须 active 且确实属于该 Source，否则抛错。
  // [契约] profile 必须 active 且 sourceServerId 匹配，否则抛错。
  // [失败路径] 不校验归属会让 A 设备的首选指向 B 设备的线路。
  // [契约] 未知 Source 抛错，不做隐式创建。
  // [契约] 只改 preferredProfileId 一个字段，不触碰 lastConnectedAt。
  public async setPreferredProfile(sourceServerId: string, profileId: string): Promise<void> {
    await this.initialize();
    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const profile = (settings.connectionProfiles ?? []).find(
        (candidate) => candidate.profileId === profileId && isActiveProfile(candidate),
      );
      if (!profile || profile.sourceServerId !== sourceServerId) {
        throw new Error(`Connection Profile ${profileId} does not belong to ${sourceServerId}`);
      }
      const servers = [...(settings.sourceServers ?? [])];
      const index = servers.findIndex((server) => server.sourceServerId === sourceServerId);
      if (index < 0) throw new Error(`Unknown Source Server: ${sourceServerId}`);
      servers[index] = { ...servers[index]!, preferredProfileId: profileId };
      await this.persistSettings({ sourceServers: servers });
    });
  }

  // 解析「可直接建连」的 target（含凭据）。接受 profileId 或已核验的 profile 对象，
  // 后者用于更新流程——避免凭据异步读取前目标被另一个请求改选。
  // 失败语义：未知/retired profile 抛错；缺交互式凭据抛带 code="credentials-required" 的错误，
  // 供上层转交给认证向导。
  // 副作用：只读 settings 与凭据缓存，不写。
  // [契约] 接受 profileId 或已核验的 Profile 对象；后者用于更新流程。
  // [失败路径] 更新流程若再按 ID 改选，凭据异步读取期间目标可能已被换掉。
  // [契约] retired Profile 抛错；未知 Profile 抛错。
  // [失败路径] 缺交互式凭据必须带 code=credentials-required，供上层交接认证向导。
  // [契约] 普通 Error 会丢语义，因此用 Object.assign 附加 code。
  // [契约] 该函数只读，不写 settings 与凭据。
  public async resolveProfileTarget(
    profileOrId: string | ConnectionProfile,
  ): Promise<Exclude<RemoteTarget, { kind: "server" }>> {
    // 更新入口传入已核验的同一 Profile，避免凭据异步读取前再次按 ID 改选执行目标。
    const profile =
      typeof profileOrId === "string"
        ? (await this.snapshot()).profiles.find((candidate) => candidate.profileId === profileOrId)
        : profileOrId;
    if (!profile) throw new Error(`Unknown Connection Profile: ${profileOrId}`);
    const profileId = profile.profileId;
    if (!isActiveProfile(profile)) throw new Error(`Connection Profile is retired: ${profileId}`);
    const target = await this.resolveSilentTarget(profile);
    if (!target)
      // 普通 Error 丢失“需要人工凭据”的语义，项目入口无法交接向导；沿用公开认证码。
      throw Object.assign(
        new Error(`Connection Profile requires interactive credentials: ${profileId}`),
        { code: "credentials-required" },
      );
    return target;
  }

  // 删除一条线路：删凭据 -> 删 profile -> 删其 workspace history -> 重算该 Source 的首选线路。
  // 失败语义：settings 写入失败时回滚已删凭据；未知 profile 幂等返回（不写不通知）。
  // 不变量：preferredProfileId 只指向仍 active 的 profile；没有候选时置 undefined。
  // [契约] 未知 profile 幂等返回：不写、不通知。
  // [失败路径] 抛错会让重试删除永远失败，UI 卡在「删除中」。
  // [契约] 顺序：删凭据 → 删 profile → 删其 history → 重算该 Source 首选。
  // [失败路径] 先删 settings 再删凭据，失败后残留 secret 且已无法定位归属。
  // [契约] 首选线路只在原指向本 profile 时重算，取第一个 active 同 Source 候选。
  // [事务] settings 写失败必须回滚已删凭据，恢复为删除前的值。
  public async removeProfile(profileId: string): Promise<void> {
    await this.initialize();
    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const profiles = [...(settings.connectionProfiles ?? [])];
      const profile = profiles.find((candidate) => candidate.profileId === profileId);
      if (!profile) return;
      const credentialKeys =
        profile.target.kind === "ssh"
          ? [
              profile.target.passwordCredentialKey,
              profile.target.privateKeyPassphraseCredentialKey,
            ].filter((key): key is string => Boolean(key))
          : [];
      const previousCredentials = new Map<string, string | null>();
      try {
        for (const key of credentialKeys) {
          previousCredentials.set(key, await this.options.credentialService.load(key));
          await this.options.credentialService.delete(key);
        }
        const remainingProfiles = profiles.filter((candidate) => candidate.profileId !== profileId);
        await this.persistSettings({
          connectionProfiles: remainingProfiles,
          sourceServerWorkspaceHistory: (settings.sourceServerWorkspaceHistory ?? []).filter(
            (entry) => entry.profileId !== profileId,
          ),
          sourceServers: (settings.sourceServers ?? []).map((server) =>
            server.preferredProfileId === profileId
              ? {
                  ...server,
                  preferredProfileId: remainingProfiles.find(
                    (candidate) =>
                      isActiveProfile(candidate) &&
                      candidate.sourceServerId === server.sourceServerId,
                  )?.profileId,
                }
              : server,
          ),
        });
      } catch (error) {
        await this.restoreCredentials(previousCredentials);
        throw error;
      }
    });
  }

  // 删除整台 Source：清 profiles、source 记录、workspace history（含按 profileId 兜底的孤儿条目）、
  // conversation 路径映射与全部 SSH 凭据。
  // 幂等：无任何本地记录时直接返回，不写不通知。
  // 失败语义：settings 写失败回滚凭据；否则原样上抛。
  // 注意：本方法只负责持久化；运行态断开与 attachment 清理由 management service 的
  // onBeforeSourceServerRemoved 回调完成（#18）。
  // [契约] 幂等：没有任何本地记录时直接返回，不写不通知。
  // [失败路径] 无条件 persistSettings 会触发一次空变更事件，导致全量重读。
  // [契约] history 过滤同时按 sourceServerId 与 removedProfileIds 兜底。
  // [失败路径] 只按设备 id 过滤会留下识别前写入的孤儿条目。
  // [契约] 凭据按被删 Profile 的 key 收集，不按 sourceServerId 猜。
  // [契约] 运行态断开与 attachment 清理不在本方法内，由 management service 回调负责。
  public async removeSourceServer(sourceServerId: string): Promise<void> {
    await this.initialize();
    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const profiles = [...(settings.connectionProfiles ?? [])];
      const removedProfiles = profiles.filter(
        (profile) => profile.sourceServerId === sourceServerId,
      );
      // 幂等空操作：设备无任何本地记录时直接成功返回，不产生写入也不发布变更事件。
      const hasAnyRecord =
        removedProfiles.length > 0 ||
        (settings.sourceServers ?? []).some((server) => server.sourceServerId === sourceServerId) ||
        (settings.sourceServerWorkspaceHistory ?? []).some(
          (entry) => entry.sourceServerId === sourceServerId,
        ) ||
        Boolean(settings.remoteConversationWorkspaceBySourceServerId?.[sourceServerId]);
      // [契约] 幂等空操作：无任何本地记录时不写 settings，也不发变更事件。
      // [失败路径] 无条件走 persist 会删除一个不存在的设备并广播一次全量重读。
      // [契约] 判定覆盖 profiles/servers/history/conversation 路径四类记录。
      // [失败路径] 只看 profiles 会漏掉只有 conversation 映射的设备，删除不干净。
      if (!hasAnyRecord) return;
      // Bug 原因：识别前写入的 workspace history 尚未回填 sourceServerId，只按设备 id 过滤
      // 会留下指向已删 Profile 的孤儿条目；删除面必须同时覆盖被删设备全部 Profile 的条目。
      const removedProfileIds = new Set(removedProfiles.map((profile) => profile.profileId));
      const credentialKeys = removedProfiles.flatMap((profile) =>
        profile.target.kind === "ssh"
          ? [
              profile.target.passwordCredentialKey,
              profile.target.privateKeyPassphraseCredentialKey,
            ].filter((key): key is string => Boolean(key))
          : [],
      );
      const previousCredentials = new Map<string, string | null>();
      try {
        for (const key of credentialKeys) {
          previousCredentials.set(key, await this.options.credentialService.load(key));
          await this.options.credentialService.delete(key);
        }
        await this.persistSettings({
          connectionProfiles: profiles.filter(
            (profile) => profile.sourceServerId !== sourceServerId,
          ),
          sourceServers: (settings.sourceServers ?? []).filter(
            (server) => server.sourceServerId !== sourceServerId,
          ),
          sourceServerWorkspaceHistory: (settings.sourceServerWorkspaceHistory ?? []).filter(
            (entry) =>
              entry.sourceServerId !== sourceServerId && !removedProfileIds.has(entry.profileId),
          ),
          remoteConversationWorkspaceBySourceServerId: Object.fromEntries(
            Object.entries(settings.remoteConversationWorkspaceBySourceServerId ?? {}).filter(
              ([key]) => key !== sourceServerId,
            ),
          ),
        });
      } catch (error) {
        await this.restoreCredentials(previousCredentials);
        throw error;
      }
    });
  }

  // 标记该 profile 所属设备为 uninstalled：仅当 profile active 且已有 sourceServerId 时生效；
  // 无匹配时幂等返回。用于「远端已没有安装产物」的目录事实，不改变连接可用性。
  // [契约] 仅当 profile active 且已有 sourceServerId 时生效。
  // [失败路径] 未识别 profile 直接 return，避免把 installState 写到错误设备。
  // [契约] 只改 installState，不改变连接可用性。
  // [失败路径] 顺手改 lifecycleState 会让设备从重连候选中消失。
  public async markSourceUninstalled(profileId: string): Promise<void> {
    await this.initialize();
    await this.enqueue(async () => {
      const settings = await this.options.settingService.get();
      const profile = (settings.connectionProfiles ?? []).find(
        (candidate) => candidate.profileId === profileId && isActiveProfile(candidate),
      );
      if (!profile?.sourceServerId) return;
      await this.persistSettings({
        sourceServers: (settings.sourceServers ?? []).map((server) =>
          server.sourceServerId === profile.sourceServerId
            ? { ...server, installState: "uninstalled" as const }
            : server,
        ),
      });
    });
  }

  // 身份替换事务：用户已确认「远端换成了另一台设备」。旧 profile 标 retired 并保留历史，
  // 新建 profile（新 id）承接新身份，workspace history 与 controller 记录整体改写到新 key。
  // 为什么换新 profileId：attachment/日志/成员关系都以 profileId 为键，复用旧 id 会让
  // 旧代际的缓存与成员关系误命中新设备。
  // 失败语义：新 id 冲突、凭据迁移失败、settings 写入失败都抛错；已创建的凭据在失败时清理。
  // 副作用：写凭据与 settings，可能改写 controller workspace key（失败计入 migrationFailures）。
  // [契约] 用户已确认换绑：旧 profile 标 retired 并保留，新建 profile 承接新身份。
  // [失败路径] 复用旧 profileId 会让 attachment/成员关系误命中新设备。
  // [契约] SSH 凭据复制到新 key，失败时按 createdCredentialKeys 逐个清理。
  // [失败路径] 只删部分 key 会留下无人引用的 secret。
  // [契约] 旧 Server 记录标 uninstalled 并重算 preferredProfileId。
  // [契约] 旧 history 原样保留，不随新安装改写 identity。
  private async commitIdentityReplacement(input: {
    settings: AppSettings;
    currentProfile: ConnectionProfile;
    handshake: SourceServerHandshakeRecord;
    connectedAt: number;
  }): Promise<SourceServerHandshakeResult> {
    const previousSourceServerId = input.currentProfile.sourceServerId!;
    const newProfileId = this.createProfileId();
    if (newProfileId === input.currentProfile.profileId) {
      throw new Error("Identity replacement requires a new Connection Profile id");
    }
    // [事务] 该数组是本轮新建的凭据 key 清单，失败时按它逐个删除。
    // [失败路径] 漏 push 某个 key 会在失败后留下无人引用的 secret。
    // [契约] 只记录本轮新建的 key，不包含继承自旧 Profile 的引用。
    // [失败路径] 把继承的 key 也记进来，失败回滚会把仍在使用的凭据删掉。
    // [契约] 清理用 catch(() => undefined) 包裹，单个删除失败不掩盖原始错误。
    const createdCredentialKeys: string[] = [];
    let target = input.currentProfile.target;
    try {
      if (input.currentProfile.target.kind === "ssh") {
        const password = input.currentProfile.target.passwordCredentialKey
          ? await this.options.credentialService.load(
              input.currentProfile.target.passwordCredentialKey,
            )
          : null;
        const passphrase = input.currentProfile.target.privateKeyPassphraseCredentialKey
          ? await this.options.credentialService.load(
              input.currentProfile.target.privateKeyPassphraseCredentialKey,
            )
          : null;
        const passwordCredentialKey =
          password === null ? undefined : newCredentialKey(newProfileId, "password");
        const privateKeyPassphraseCredentialKey =
          passphrase === null
            ? undefined
            : newCredentialKey(newProfileId, "private-key-passphrase");
        if (passwordCredentialKey) {
          createdCredentialKeys.push(passwordCredentialKey);
          await this.options.credentialService.save(passwordCredentialKey, password!);
        }
        if (privateKeyPassphraseCredentialKey) {
          createdCredentialKeys.push(privateKeyPassphraseCredentialKey);
          await this.options.credentialService.save(privateKeyPassphraseCredentialKey, passphrase!);
        }
        target = {
          ...input.currentProfile.target,
          passwordCredentialKey,
          privateKeyPassphraseCredentialKey,
        };
      }

      const retiredProfile: ConnectionProfile = {
        ...input.currentProfile,
        lifecycleState: "retired",
        retiredReason: "source-reinstalled",
        retiredAt: input.connectedAt,
      };
      const newProfile: ConnectionProfile = {
        ...input.currentProfile,
        profileId: newProfileId,
        sourceServerId: input.handshake.sourceServerId,
        target,
        lifecycleState: "active",
        retiredReason: undefined,
        retiredAt: undefined,
        lastConnectedAt: input.connectedAt,
        lastConnectError: undefined,
        createdAt: input.connectedAt,
      } as ConnectionProfile;
      const profiles = (input.settings.connectionProfiles ?? []).map((profile) =>
        profile.profileId === input.currentProfile.profileId ? retiredProfile : profile,
      );
      profiles.push(newProfile);
      const defaultDisplayName = resolveDefaultSourceDisplayName(newProfile, input.handshake);
      const servers = [...(input.settings.sourceServers ?? [])];
      const oldServerIndex = servers.findIndex(
        (server) => server.sourceServerId === previousSourceServerId,
      );
      if (oldServerIndex >= 0) {
        const oldServer = servers[oldServerIndex]!;
        servers[oldServerIndex] = {
          ...oldServer,
          installState: "uninstalled",
          preferredProfileId: profiles.find(
            (profile) =>
              isActiveProfile(profile) && profile.sourceServerId === previousSourceServerId,
          )?.profileId,
        };
      }
      const newServerIndex = servers.findIndex(
        (server) => server.sourceServerId === input.handshake.sourceServerId,
      );
      const existingNewServer = newServerIndex >= 0 ? servers[newServerIndex] : undefined;
      const newServer: SourceServerRecord = {
        sourceServerId: input.handshake.sourceServerId,
        displayName: existingNewServer?.displayName ?? defaultDisplayName,
        ...(input.handshake.osUser ? { osUser: input.handshake.osUser } : {}),
        ...(input.handshake.hostname ? { hostname: input.handshake.hostname } : {}),
        lastSeenVersion: input.handshake.version,
        lastOnlineAt: input.connectedAt,
        preferredProfileId: newProfileId,
        installState: "installed",
        declaredWorkspaces: projectDeclaredWorkspaces(
          input.handshake.sourceServerId,
          input.handshake.workspaces ?? [],
          this.options.logDebug,
        ),
      };
      if (newServerIndex >= 0) servers[newServerIndex] = newServer;
      else servers.push(newServer);
      await this.persistSettings({
        connectionProfiles: profiles,
        sourceServers: servers,
        // 旧 history 保持旧 Source/Profile 身份，不允许随新安装静默改写。
        sourceServerWorkspaceHistory: input.settings.sourceServerWorkspaceHistory ?? [],
      });
      return {
        identityChanged: true,
        migrationFailures: [],
        effectiveProfileId: newProfileId,
        effectiveProfile: newProfile,
      };
    } catch (error) {
      await Promise.all(
        createdCredentialKeys.map(
          async (key) => await this.options.credentialService.delete(key).catch(() => undefined),
        ),
      );
      throw error;
    }
  }

  // 一次性 legacy 迁移（migrationVersion 未到 1 时执行）：把旧 remote 会话条目改写为
  // canonical source 记录与 workspace history，并写入版本号。
  // 幂等性：版本号是唯一开关；重复调用不会重复迁移。失败时抛错，initialize 会清缓存并允许重试。
  // [契约] 版本号是唯一开关，重复调用不会重复迁移。
  // [失败路径] 失败必须恢复本轮所有凭据写入，再上抛让 initialize 重试。
  // [失败路径] 不恢复会让重试生成新 profileId，旧 key 永久残留。
  // [契约] 恢复后保留 legacy key，供下一次初始化重新迁移。
  // [事务] 迁移的提交点是 persistSettings 写入 migrationVersion=1。
  private async migrateLegacyRemoteEntries(settings: AppSettings): Promise<void> {
    const previousCredentials = new Map<string, string | null>();
    try {
      await this.persistLegacyRemoteEntries(settings, previousCredentials);
    } catch (error) {
      // Bug 原因：legacy 迁移先落新 Profile 凭据、最后提交 Directory settings；settings
      // 写入失败后重试会生成新 profileId，旧 key 因无人引用而永久残留。迁移失败必须在
      // 返回前恢复本轮所有凭据写入，保留 legacy key 供下一次初始化重新迁移。
      await this.restoreCredentials(previousCredentials);
      throw error;
    }
  }

  // [契约] 按 routeKey 分组，同一路由的多个 workspace 合并成一条 Profile。
  // [失败路径] 不分组会为每个 workspace 建一条 Profile，线路列表爆炸。
  // [契约] createdAt 取组内最早 lastOpenedAt，lastConnectedAt 只在最近一次成功时设置。
  // [失败路径] 用 now() 会让迁移后的排序与真实历史不符。
  // [契约] 只有 shouldMigrateProfiles 时才复制凭据。
  // [失败路径] 已有 Profile 时仍复制，会为被丢弃的临时 Profile 造 orphan key。
  private async persistLegacyRemoteEntries(
    settings: AppSettings,
    previousCredentials: Map<string, string | null>,
  ): Promise<void> {
    const remoteEntries = (settings.lastWorkspaceSession ?? [])
      .filter((entry) => entry.kind === "remote" && entry.target.kind !== "server")
      .map((entry) => entry as LegacySourceWorkspaceEntry);
    const groups = new Map<string, typeof remoteEntries>();
    for (const entry of remoteEntries) {
      const key = routeKey(entry);
      if (!key) continue;
      const values = groups.get(key) ?? [];
      values.push(entry);
      groups.set(key, values);
    }

    const profiles: ConnectionProfile[] = [];
    const workspaceHistory: SourceServerWorkspaceHistoryEntry[] = [];
    // [契约] 只有完全没有既有 Profile 时才迁移并落 secret。
    // [失败路径] 已有 Profile 仍复制凭据，会为随后被丢弃的临时 Profile 造 orphan key。
    // [契约] 该布尔同时决定 target 走 migrateProfileTarget 还是纯归一化。
    // [失败路径] 两条路径混用会写出没有对应 secret 的 credential 引用。
    // [权衡] settings 里已有 Profile 即视为权威值，迁移不再覆盖。
    const shouldMigrateProfiles = !settings.connectionProfiles?.length;
    for (const entries of groups.values()) {
      const ordered = [...entries].sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
      const latest = ordered[0]!;
      const profileId = this.createProfileId();
      // 既有 Profile 会作为本次 settings patch 的权威值保留；为随后被丢弃的临时 Profile
      // 复制凭据会在成功迁移时也制造 orphan key，因此只有真正进入提交集的 Profile 才落 secret。
      const target = shouldMigrateProfiles
        ? await this.migrateProfileTarget(
            profileId,
            latest.target,
            previousCredentials,
            ordered.map((entry) => entry.target),
          )
        : this.profileTargetFromRemote(latest.target);
      const transport = target.kind;
      profiles.push({
        profileId,
        transport,
        target,
        displayName:
          target.kind === "ssh"
            ? (target.sshConfigAlias ?? target.host)
            : target.kind === "wsl"
              ? (target.distro ?? "WSL")
              : target.container,
        createdAt: Math.min(...entries.map((entry) => entry.lastOpenedAt)),
        lastConnectedAt:
          latest.lastConnectionStatus === "connected" ? latest.lastOpenedAt : undefined,
        lastConnectError: latest.lastConnectionError,
      } as ConnectionProfile);
      for (const entry of entries) {
        workspaceHistory.push({
          workspacePath: entry.workspacePath,
          ...(entry.workspaceIdentity ? { legacyWorkspaceIdentity: entry.workspaceIdentity } : {}),
          profileId,
          lastOpenedAt: entry.lastOpenedAt,
        });
      }
    }

    await this.persistSettings({
      sourceServers: settings.sourceServers ?? [],
      connectionProfiles: settings.connectionProfiles?.length
        ? settings.connectionProfiles
        : profiles,
      sourceServerWorkspaceHistory: settings.sourceServerWorkspaceHistory?.length
        ? settings.sourceServerWorkspaceHistory
        : workspaceHistory.sort((left, right) => left.lastOpenedAt - right.lastOpenedAt),
      sourceServerDirectoryMigrationVersion: 1,
    });
  }

  // 启动期修复：清理「profile 已不存在但凭据仍残留」的 key（尽力而为，失败只 warn 不阻断启动）。
  // 只处理可安全判定的悬空项，不猜测仍被其它 profile 引用的凭据。
  // [契约] 尽力而为：失败只 warn，不阻断启动。
  // [失败路径] 抛错会让 UI 因一次凭据修复失败完全打不开。
  // [契约] 只修「引用存在但值为 null」的精确 route 场景。
  // [失败路径] 按 alias/hostname 猜测其它连接的 secret 会把凭据串到错误设备。
  // [契约] 私钥口令只在 privateKeyPath 存在时才修复。
  // [契约] migrationVersion=1 也要审计，旧 Desktop 可能已剥离过字段。
  private async repairDanglingProfileCredentials(settings: AppSettings): Promise<void> {
    // Bug 原因：旧 Desktop 写回 settings 会剥离 Source Directory，新版再次迁移时可能已把
    // 空 legacy key 变成 canonical Profile ref。migrationVersion=1 也必须按精确 route 幂等
    // 审计并恢复真实 value；禁止根据 alias/hostname 猜测其它连接的 secret。
    // [契约] 启动修复前先按精确 route 聚合 legacy 条目，供「找首个真实值」使用。
    // [失败路径] 按 alias/hostname 模糊匹配会把凭据从别的连接复制过来。
    // [契约] 每组按 lastOpenedAt 倒序，保证优先使用最近使用的真实值。
    // [失败路径] 不排序会让一条更旧的空值遮住可用的凭据。
    // [契约] 无 routeKey 的 server 直连条目被跳过，不参与修复。
    const legacyEntriesByRoute = new Map<string, LegacySourceWorkspaceEntry[]>();
    for (const entry of settings.lastWorkspaceSession ?? []) {
      if (entry.kind !== "remote" || entry.target.kind === "server") continue;
      const key = routeKey(entry);
      if (!key) continue;
      const entries = legacyEntriesByRoute.get(key) ?? [];
      entries.push(entry as LegacySourceWorkspaceEntry);
      legacyEntriesByRoute.set(key, entries);
    }
    for (const entries of legacyEntriesByRoute.values()) {
      entries.sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
    }

    for (const profile of settings.connectionProfiles ?? []) {
      if (!isActiveProfile(profile) || profile.target.kind !== "ssh") continue;
      const entries = legacyEntriesByRoute.get(
        [
          "ssh",
          profile.target.host.trim().toLowerCase(),
          String(profile.target.port ?? 22),
          profile.target.username.trim(),
          profile.target.privateKeyPath?.trim() ?? "",
        ].join("\u0000"),
      );
      if (!entries?.length) continue;

      const passwordCredentialKey = profile.target.passwordCredentialKey;
      if (
        passwordCredentialKey &&
        (await this.options.credentialService.load(passwordCredentialKey)) === null
      ) {
        await this.copyFirstAvailableCredential(
          entries.flatMap((entry) =>
            entry.target.kind === "ssh" && entry.target.passwordCredentialKey
              ? [entry.target.passwordCredentialKey]
              : [],
          ),
          passwordCredentialKey,
        );
      }

      const privateKeyPassphraseCredentialKey =
        profile.target.privateKeyPath && profile.target.privateKeyPassphraseCredentialKey;
      if (
        privateKeyPassphraseCredentialKey &&
        (await this.options.credentialService.load(privateKeyPassphraseCredentialKey)) === null
      ) {
        await this.copyFirstAvailableCredential(
          entries.flatMap((entry) =>
            entry.target.kind === "ssh" &&
            entry.target.privateKeyPath &&
            entry.target.privateKeyPassphraseCredentialKey
              ? [entry.target.privateKeyPassphraseCredentialKey]
              : [],
          ),
          privateKeyPassphraseCredentialKey,
        );
      }
    }
  }

  // [契约] SSH 迁移只复制存在真实值的凭据，并用 copied 布尔决定是否写引用。
  // [失败路径] 源值为空仍写引用，会让 Profile 指向不存在的 secret。
  // [契约] 密码与私钥口令必须顺序 await，不能 Promise.all。
  // [失败路径] 并行时先 reject 会让另一条 save 越过 rollback 再落盘。
  // [契约] 私钥口令只在 privateKeyPath 存在时视为当前认证方式。
  // [失败路径] 保留无 privateKeyPath 的口令 ref 会平白阻断完整密码认证。
  private async migrateProfileTarget(
    profileId: string,
    target: LegacySourceWorkspaceEntry["target"],
    previousCredentials: Map<string, string | null>,
    credentialSources: readonly LegacySourceWorkspaceEntry["target"][] = [target],
  ): Promise<SSHProfileTarget | WSLProfileTarget | DockerProfileTarget> {
    if (target.kind === "ssh") {
      const nextPasswordCredentialKey = newCredentialKey(profileId, "password");
      const nextPrivateKeyPassphraseCredentialKey = newCredentialKey(
        profileId,
        "private-key-passphrase",
      );
      const passwordCopied = await this.copyFirstAvailableCredential(
        credentialSources.flatMap((candidate) =>
          candidate.kind === "ssh" && candidate.passwordCredentialKey
            ? [candidate.passwordCredentialKey]
            : [],
        ),
        nextPasswordCredentialKey,
        previousCredentials,
      );
      // 两类凭据必须顺序等待：并行 Promise 提前 reject 时，另一条迟到 save 可能越过
      // migration rollback 再落盘，重新制造无人引用的 key。
      const privateKeyPassphraseCopied = target.privateKeyPath
        ? await this.copyFirstAvailableCredential(
            credentialSources.flatMap((candidate) =>
              candidate.kind === "ssh" &&
              candidate.privateKeyPath &&
              candidate.privateKeyPassphraseCredentialKey
                ? [candidate.privateKeyPassphraseCredentialKey]
                : [],
            ),
            nextPrivateKeyPassphraseCredentialKey,
            previousCredentials,
          )
        : false;
      // Bug 原因：旧 snapshot 可能在密码认证时仍携带私钥口令 ref。
      // 口令只有在 privateKeyPath 存在时才属于当前认证方式，否则迁移后会平白阻断完整密码。
      // 实际私钥认证的 ref 仍保留：若对应值缺失，它必须继续触发交互凭据，不能静默降级。
      return {
        kind: "ssh",
        host: target.host.trim().toLowerCase(),
        port: target.port ?? 22,
        username: target.username.trim(),
        ...(target.sshConfigAlias ? { sshConfigAlias: target.sshConfigAlias } : {}),
        ...(target.privateKeyPath ? { privateKeyPath: target.privateKeyPath } : {}),
        ...(target.assetInstallMode ? { assetInstallMode: target.assetInstallMode } : {}),
        ...(passwordCopied ? { passwordCredentialKey: nextPasswordCredentialKey } : {}),
        ...(privateKeyPassphraseCopied
          ? {
              privateKeyPassphraseCredentialKey: nextPrivateKeyPassphraseCredentialKey,
            }
          : {}),
      };
    }
    if (target.kind === "wsl") {
      return {
        kind: "wsl",
        ...(target.distro ? { distro: target.distro.trim() } : {}),
        ...(target.user ? { user: target.user.trim() } : {}),
      };
    }
    return { kind: "docker", container: target.container.trim() };
  }

  // [契约] 该函数只做字段归一化（trim/lowercase/默认 port），不读写凭据。
  // [失败路径] 在其中读取凭据会让纯函数带 IO，调用方无法预期失败点。
  // [契约] 可选字段用条件展开，缺省时不写出 undefined 键。
  // [失败路径] 写 undefined 键会让 JSON 比较与持久化结果不稳定。
  // [权衡] 与 migrateProfileTarget 的输出字段保持一致，避免两套 shape。
  private profileTargetFromRemote(
    target: Exclude<RemoteTarget, { kind: "server" }>,
  ): SSHProfileTarget | WSLProfileTarget | DockerProfileTarget {
    if (target.kind === "ssh") {
      return {
        kind: "ssh",
        host: target.host.trim().toLowerCase(),
        port: target.port ?? 22,
        username: target.username.trim(),
        ...(target.sshConfigAlias ? { sshConfigAlias: target.sshConfigAlias } : {}),
        ...(target.privateKeyPath ? { privateKeyPath: target.privateKeyPath } : {}),
        ...(target.assetInstallMode ? { assetInstallMode: target.assetInstallMode } : {}),
      };
    }
    if (target.kind === "wsl") {
      return {
        kind: "wsl",
        ...(target.distro ? { distro: target.distro.trim() } : {}),
        ...(target.user ? { user: target.user.trim() } : {}),
      };
    }
    return { kind: "docker", container: target.container.trim() };
  }

  // [契约] 按 sourceKeys 顺序找到第一个真实值即停止。
  // [失败路径] 只看最新 workspace 的 key，源值为空时仍会生成新 ref。
  // [契约] 只有复制成功才返回 true，调用方据此决定是否写引用。
  // [失败路径] 返回 void 会让调用方无法区分「复制了」与「没有可复制值」。
  // [契约] 传 previousCredentials 时先记录目标 key 的旧值，供 rollback 使用。
  private async copyFirstAvailableCredential(
    sourceKeys: readonly string[],
    destinationKey: string,
    previousCredentials?: Map<string, string | null>,
  ): Promise<boolean> {
    for (const sourceKey of sourceKeys) {
      const value = await this.options.credentialService.load(sourceKey);
      if (value === null) continue;
      // Bug 原因：旧迁移只看最新 workspace 的 key，源值为空时仍生成新的 Profile ref。
      // 同 route 按 lastOpenedAt 顺序寻找首个真实值，且只有复制成功才允许调用方写引用。
      if (previousCredentials && !previousCredentials.has(destinationKey)) {
        previousCredentials.set(
          destinationKey,
          await this.options.credentialService.load(destinationKey),
        );
      }
      await this.options.credentialService.save(destinationKey, value);
      return true;
    }
    return false;
  }

  // [契约] 非 SSH 或目标非 SSH 时返回空 rollback，不触碰凭据服务。
  // [失败路径] 对所有 transport 都走凭据分支会写出无意义的 key。
  // [契约] 只有传入新 password/passphrase 才写，否则沿用既有引用。
  // [失败路径] 空字符串被当成「要写入」，会把已有口令覆盖成空。
  // [契约] 写失败先 restoreCredentials 再抛错，不留半写状态。
  // [契约] nextTarget 与 profileTarget 等价时返回原对象，避免无意义对象换引用。
  private async persistProfileCredentials(
    profileId: string,
    target: Exclude<RemoteTarget, { kind: "server" }>,
    profileTarget: SSHProfileTarget | WSLProfileTarget | DockerProfileTarget,
  ): Promise<{
    target: SSHProfileTarget | WSLProfileTarget | DockerProfileTarget;
    rollback: () => Promise<void>;
  }> {
    if (target.kind !== "ssh" || profileTarget.kind !== "ssh") {
      return { target: profileTarget, rollback: async () => undefined };
    }
    const passwordCredentialKey = target.password?.length
      ? (profileTarget.passwordCredentialKey ?? newCredentialKey(profileId, "password"))
      : profileTarget.passwordCredentialKey;
    const privateKeyPassphraseCredentialKey = target.privateKeyPassphrase?.length
      ? (profileTarget.privateKeyPassphraseCredentialKey ??
        newCredentialKey(profileId, "private-key-passphrase"))
      : profileTarget.privateKeyPassphraseCredentialKey;
    const writes = [
      ...(target.password?.length && passwordCredentialKey
        ? [{ key: passwordCredentialKey, value: target.password }]
        : []),
      ...(target.privateKeyPassphrase?.length && privateKeyPassphraseCredentialKey
        ? [
            {
              key: privateKeyPassphraseCredentialKey,
              value: target.privateKeyPassphrase,
            },
          ]
        : []),
    ];
    const previous = new Map<string, string | null>();
    try {
      for (const write of writes) {
        previous.set(write.key, await this.options.credentialService.load(write.key));
        await this.options.credentialService.save(write.key, write.value);
      }
    } catch (error) {
      await this.restoreCredentials(previous);
      throw error;
    }
    const nextTarget: SSHProfileTarget = {
      ...profileTarget,
      ...(passwordCredentialKey ? { passwordCredentialKey } : {}),
      ...(privateKeyPassphraseCredentialKey ? { privateKeyPassphraseCredentialKey } : {}),
    };
    const changed =
      nextTarget.passwordCredentialKey !== profileTarget.passwordCredentialKey ||
      nextTarget.privateKeyPassphraseCredentialKey !==
        profileTarget.privateKeyPassphraseCredentialKey;
    return {
      target: changed ? nextTarget : profileTarget,
      rollback: async () => await this.restoreCredentials(previous),
    };
  }

  // [契约] value 为 null 表示原本不存在，回滚即删除；否则写回原值。
  // [失败路径] 把 null 当字符串写回，会在凭据库里留下 "null" 这种脏值。
  // [并发] 每个 key 独立回滚，用 Promise.all 并行，互不依赖。
  // [失败路径] 回滚是尽力而为：单个失败不阻断其它 key 的恢复。
  // [契约] 该函数不记录日志，调用方负责把失败暴露给上层。
  private async restoreCredentials(previous: ReadonlyMap<string, string | null>): Promise<void> {
    await Promise.all(
      [...previous].map(async ([key, value]) => {
        if (value === null) await this.options.credentialService.delete(key);
        else await this.options.credentialService.save(key, value);
      }),
    );
  }

  // 解析可用于「静默建连」的 target：凭据缺失/不可用返回 undefined（不抛错），
  // 让调用方（启动重连）跳过该 profile 而不是整体失败；不触发任何交互式认证。
  // [契约] WSL/Docker 无凭据概念，直接返回 target。
  // [失败路径] 对它们走 SSH 凭据分支会读到不存在的字段。
  // [契约] 密码或私钥任一认证链完整即可静默连接。
  // [失败路径] 要求所有引用都有值，会把完整密码认证误判为需要交互。
  // [契约] 私钥口令缺省仍算完整：无口令私钥是合法配置。
  // [契约] 返回 null 是正常信号（跳过该候选），不是错误。
  private async resolveSilentTarget(
    profile: ConnectionProfile,
  ): Promise<Exclude<RemoteTarget, { kind: "server" }> | null> {
    if (profile.target.kind === "wsl" || profile.target.kind === "docker") {
      return profile.target;
    }
    const password = profile.target.passwordCredentialKey
      ? await this.options.credentialService.load(profile.target.passwordCredentialKey)
      : null;
    const privateKeyPassphrase =
      profile.target.privateKeyPath && profile.target.privateKeyPassphraseCredentialKey
        ? await this.options.credentialService.load(
            profile.target.privateKeyPassphraseCredentialKey,
          )
        : null;
    // Bug 原因：legacy workspace 迁移可能留下没有 privateKeyPath 的私钥口令引用。
    // 旧逻辑要求所有引用都有值，把已完整的密码认证也误判为需要交互凭据。
    // SSH 密码和私钥是可替代方案；只要其中一条认证链完整即可静默连接。
    const hasPasswordAuth = Boolean(password);
    const hasPrivateKeyAuth = Boolean(
      profile.target.privateKeyPath &&
      (!profile.target.privateKeyPassphraseCredentialKey || privateKeyPassphrase),
    );
    if (!hasPasswordAuth && !hasPrivateKeyAuth) return null;
    return {
      kind: "ssh",
      host: profile.target.host,
      port: profile.target.port,
      username: profile.target.username,
      ...(profile.target.sshConfigAlias ? { sshConfigAlias: profile.target.sshConfigAlias } : {}),
      ...(hasPrivateKeyAuth && profile.target.privateKeyPath
        ? { privateKeyPath: profile.target.privateKeyPath }
        : {}),
      ...(profile.target.assetInstallMode
        ? { assetInstallMode: profile.target.assetInstallMode }
        : {}),
      ...(password ? { password } : {}),
      ...(hasPrivateKeyAuth && privateKeyPassphrase ? { privateKeyPassphrase } : {}),
    };
  }

  // [并发] writeChain.then(run, run) 保证前一次失败后仍继续排队，链不断裂。
  // [失败路径] 只在成功回调里接续，会让一次失败永久卡死写入队列。
  // [契约] 每次执行前重置 didPersistInCurrentOperation，防止跨操作串味。
  // [契约] 只有 didPersist=true 才 fire onDidChange。
  // [失败路径] 无条件 fire 会让 no-op 操作也驱动全部消费方权威重读快照。
  // [契约] 事件在事务结束后发出，消费方读到的必然是已落盘状态。
  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    // Bug 原因：过去 enqueue 完成后无条件 fire onDidChange，未写入的操作（已迁移短路、
    // identity-pending 零写入分支、目标不存在的 no-op）也会驱动全部消费方权威重读快照。
    // 事件语义收敛为「确有持久化写入成功才通知」；写入统一走 persistSettings 打标。
    const run = async (): Promise<{ value: T; didPersist: boolean }> => {
      this.didPersistInCurrentOperation = false;
      const value = await operation();
      return { value, didPersist: this.didPersistInCurrentOperation };
    };
    const result = this.writeChain.then(run, run);
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    const { value, didPersist } = await result;
    if (didPersist) this.changeEmitter.fire();
    return value;
  }

  /** 目录持久化写入的唯一入口：写入成功即标记本次 enqueue 操作需要发布变更事件。 */
  // 统一持久化出口：写 settings，并在本次 enqueue 内标记「确实写入」，
  // 由 enqueue 在事务结束后据此决定是否 fire onDidChange（失败则不通知）。
  // [契约] 目录持久化写入的唯一入口，也是 didPersist 的唯一打标点。
  // [失败路径] 绕过它直接 update 会让 enqueue 认为本次没有写入，不发出变更事件。
  // [契约] update 抛错时不打标，didPersist 保持 false。
  // [契约] patch 是部分字段，调用方必须先 get 再拼完整数组，避免覆盖并发的其它字段。
  private async persistSettings(patch: Partial<AppSettings>): Promise<void> {
    await this.options.settingService.update(patch);
    this.didPersistInCurrentOperation = true;
  }
}

// [契约] 设备记录必须使用设备级 canonical identity，不信任远端传回的 identity。
// [失败路径] 采信线路级 identity 会让同一 workspace 在不同线路下出现多条记录。
// [契约] identity 不合法或不等价时一律回落 canonicalIdentity。
// [契约] 覆盖只记 debug，不报错（合同 §8.1.1）。
// [契约] 按 identity 去重，最多保留 20 条，避免恶意/异常远端撑爆 settings。
// [失败路径] 不做上限会让一次握手写入成千上万条 declaredWorkspaces。
function projectDeclaredWorkspaces(
  sourceServerId: string,
  workspaces: readonly SourceServerDeclaredWorkspaceWire[],
  logDebug?: (message: string) => void,
): SourceServerRecord["declaredWorkspaces"] {
  // [契约] 先构造 workspacePath="/" 的设备级 identity，再从它解析出 canonicalServerId。
  // [失败路径] 直接拿 sourceServerId 比较会绕过格式统一，跨代际 id 不等价。
  // [契约] 校验远端 identity 时既比较 sourceServerId 也比较规范化后的 path。
  // [失败路径] 只比较 sourceServerId 会放过路径大小写/分隔符不同的伪造 identity。
  // [契约] canonicalServerId 可能为 undefined，此时任何远端 identity 都不合法。
  const canonicalServerIdentity = buildServerRemoteWorkspaceIdentity({
    serverId: sourceServerId,
    workspacePath: "/",
  });
  const canonicalServerId = parseRemoteWorkspaceIdentity(canonicalServerIdentity)?.sourceServerId;
  const result: NonNullable<SourceServerRecord["declaredWorkspaces"]> = [];
  const seen = new Set<string>();
  for (const workspace of workspaces) {
    const workspacePath = workspace.path.trim();
    if (!workspacePath) continue;
    const canonicalIdentity = buildServerRemoteWorkspaceIdentity({
      serverId: sourceServerId,
      workspacePath,
    });
    const parsedIdentity = workspace.workspaceIdentity
      ? parseRemoteWorkspaceIdentity(workspace.workspaceIdentity)
      : null;
    const identityIsValid =
      parsedIdentity?.kind === "server" &&
      parsedIdentity.sourceServerId === canonicalServerId &&
      parsedIdentity.workspacePath ===
        parseRemoteWorkspaceIdentity(canonicalIdentity)?.workspacePath;
    // 设备记录必须使用设备级 canonical identity；不信任远端传回的线路级或跨设备 identity。
    const workspaceIdentity =
      identityIsValid && workspace.workspaceIdentity === canonicalIdentity
        ? workspace.workspaceIdentity
        : canonicalIdentity;
    // 合同 §8.1.1：远端 identity 校验不通过被 canonical 覆盖时仅记 debug 日志、不报错。
    if (workspace.workspaceIdentity && workspace.workspaceIdentity !== workspaceIdentity) {
      logDebug?.(
        `Source Server declared workspace identity overridden by canonical: server=${sourceServerId} path=${workspacePath} remote=${workspace.workspaceIdentity}`,
      );
    }
    if (seen.has(workspaceIdentity)) continue;
    seen.add(workspaceIdentity);
    result.push({
      workspacePath,
      workspaceIdentity,
      ...(workspace.label ? { label: workspace.label } : {}),
    });
    if (result.length >= 20) break;
  }
  return result;
}
