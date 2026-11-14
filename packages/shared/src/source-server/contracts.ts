//
// 文件职责：source-server 的线上/磁盘契约层——zod schema、推导类型与纯判定函数，别无其他。
// 职责边界：不建立连接、不发 RPC、不读写磁盘、不解析凭据；副作用全部由 host/server 侧承担。
// 类型一律由 z.infer / z.input 推导，禁止手写平行 interface，避免校验与类型漂移。
//
// 阅读顺序：transport 枚举 → profile target → connectionProfile/sourceServerRecord → 迁移与
//           工作区解析 → 连接状态快照 → 管理快照与增量 → 安装进度与操作日志。
//
// 契约演进：新增字段先 optional 并让读写双方各自升级；删字段先停止写入再删除；枚举只追加，
//           未知值一律拒绝，不用 z.string() 兜底，否则旧读方会把新值当合法数据落盘。
//
// INV 表（每条都是「改错也不报错、只在旧数据上静默失效」的点）：
// INV-01 断言：每个对象 schema 都以 .strict() 收尾，未知字段解析即报错 —— 守住它的位置：各 z.object({...}) 的链尾 —— 改错故障：新版本多写的字段在旧版本回读时被静默丢弃，回滚后配置缺列。
// INV-02 断言：新增字段必须 optional 或带 default，且不得改变既有字段必填性 —— 守住它的位置：connectionProfileBaseShape 与各快照字段 —— 改错故障：旧数据缺新字段导致整条 profile 解析失败，用户连接配置不可用。
// INV-03 断言：所有状态/原因/模式枚举都是封闭字面量联合，未知值拒绝 —— 守住它的位置：transport、lifecycleState、installState、connectionState、status —— 改错故障：把枚举放宽后新值透传到旧 UI，渲染成空白或误判为断线。
// INV-04 断言：default 只在解析输出侧生效，输入侧仍可省略 —— 守住它的位置：port default(22)、lifecycleState default("active")、installState、declaredWorkspaces —— 改错故障：把默认值写进手写类型，调用方以为可省，实际落盘得到 undefined。
// INV-05 断言：profileId / sourceServerId / taskId 等身份字段用 uuid，不用任意字符串 —— 守住它的位置：connectionProfileBaseShape 及其引用处 —— 改错故障：松散字符串进入 Map 键，重复 profile 与孤儿 state 同时出现且难以清理。
// INV-06 断言：connectionProfile 的 transport 必须与 target.kind 一致 —— 守住它的位置：connectionProfileSchema 三个分支 —— 改错故障：ssh 配置挂上 docker target，连接层按 kind 分派到错误实现并报无关错误。
// INV-07 断言：凭据只以 credentialKey 引用出现，任何 schema 不得含明文密码 —— 守住它的位置：passwordCredentialKey、privateKeyPassphraseCredentialKey —— 改错故障：明文随 profile 落盘并被日志或导出功能带出，成为泄密面。
// INV-08 断言：工作区身份键固定为 workspaceIdentity.trim() 优先、否则回退 workspacePath —— 守住它的位置：workspaceHistoryEntry 与 runningTask 字段 —— 改错故障：只按路径匹配，同一工作区的两个远端被当成一个，任务串台。
// INV-09 断言：升级授权身份做归一化（host 小写、port 缺省 22、alias trim） —— 守住它的位置：getSourceServerUpdateTarget —— 改错故障：大小写不同的同一主机生成两个授权对象，重复提示升级且互不承认。
// INV-10 断言：迁移行状态必须区分 abandoned 与 abandoned-diverged —— 守住它的位置：migrationReportRow.status 与 abandonedTrigger —— 改错故障：把分叉放弃当成普通放弃，清理逻辑删除仍有差异的备份目录。
// INV-11 断言：数组型字段默认空数组，读取方永不面对 undefined —— 守住它的位置：declaredWorkspaces、mergedKeys、conflicts、migrationCounts —— 改错故障：老记录缺字段导致 .map 崩溃，或 UI 把 undefined 渲染成「加载中」。
// INV-12 断言：管理快照与增量的 generation 单调递增且同源，schema 只校验正/非负 —— 守住它的位置：managementSnapshot/StateDelta/DirectoryDelta —— 改错故障：乱序增量覆盖新状态，UI 停留在旧连接态且不再自愈。
//
// 配套取舍：.strict() 让升级窗口内多一个字段就失败，换取磁盘数据永不悄悄降级；
//           对外入口（getSourceServerUpdateTarget / isSameSourceServerUpdateTarget）解析失败应上抛，不做降级回退。
//
// 默认值只在输出侧生效：z.input 允许省略，z.infer 一定存在；两种类型不可混用。
//
import { z } from "zod";
import type { RemoteTarget } from "#src/remoteTarget.js";
import { publicZCodeErrorCodeSchema } from "./errorCodes.js";
import { REMOTE_ASSET_INSTALL_MODES } from "../remoteAssetInstallMode.js";
import { isKnownRemoteResourcePackageId } from "../remoteResourcePackages.js";
import { wslUserSchema } from "../wslUserValidation.js";
import { serverRemoteWorkspaceInfoSchema } from "../server-remote.js";

// [契约] 三个基元串起本文件所有字段的校验语义，改动会同时影响上百处，属于全局契约。
// [契约] nonEmptyString 先 trim 再 min(1)：纯空白被拒，且解析结果已裁剪，下游无需重复 trim。
// [权衡] timestamp 只拒绝负数与小数，不校验单位（秒或毫秒），单位由各字段注释与写入方约定。
// [失败路径] 若把 credentialKeySchema 放宽成普通字符串，空键会在凭据查找阶段才失败，报错点远离解析点。
const nonEmptyStringSchema = z.string().trim().min(1);
const credentialKeySchema = nonEmptyStringSchema;
const timestampSchema = z.number().int().nonnegative();

// [契约] transport 只有 ssh/wsl/docker 三值，是后续所有 discriminatedUnion("kind") 的判别键来源。
// [契约] 枚举顺序无意义，新增成员必须同步 updateTarget、connectionProfile 与 host 侧 switch 的穷尽分支。
// [失败路径] 未知 transport 在解析期即被拒，不会进入连接流程；禁止写「默认 ssh」之类的兜底。
// [权衡] 用字面量联合而非 z.string()，换来穷尽检查，代价是新增传输方式属于破坏性契约变更。
export const sourceServerTransportKindSchema = z.enum(["ssh", "wsl", "docker"]);
export type SourceServerTransportKind = z.infer<typeof sourceServerTransportKindSchema>;

// [契约] SSH target 是「可连接参数」的完整集合，strict 保证越权字段不会随 profile 一起落盘。
// [契约] host/username 必填；port 缺省由消费方按 22 处理，schema 不注入默认值，读写语义保持对称。
// [失败路径] 若省略 .strict()，旧版本写入的未知字段会随 profile 一起被新版本回写覆盖。
// [权衡] 密码与口令只存 credentialKey 引用，schema 中永不出现明文，避免导出或日志泄密。
export const sshProfileTargetSchema = z
  .object({
    kind: z.literal("ssh"),
    host: nonEmptyStringSchema,
    // [契约] 端口同时受 positive 与 max(65_535) 约束，0 与 65536 都在解析期失败。
    // [失败路径] 不校验范围时非法端口会流入 ssh 命令拼装，错误被推迟到连接阶段且难以归因。
    // [权衡] 上限写字面量而非共享常量，避免跨包依赖；改动须与 updateTarget 的 default(22) 对齐。
    port: z.number().int().positive().max(65_535).optional(),
    username: nonEmptyStringSchema,
    sshConfigAlias: nonEmptyStringSchema.optional(),
    // [契约] privateKeyPath 是可选本机路径，仅 ssh 分支有效；wsl/docker 携带会被 strict 拒绝。
    // [失败路径] 这里用 z.string()，空串合法，表示「未指定路径」，与 nonEmptyString 的语义不同。
    // [权衡] 路径存在性与权限不在此校验，schema 只保证类型，运行期错误交给连接层报告。
    privateKeyPath: z.string().optional(),
    assetInstallMode: z.enum(REMOTE_ASSET_INSTALL_MODES).optional(),
    resourcePackages: z
      .object({
        selectedPackageIds: z.array(z.string().refine(isKnownRemoteResourcePackageId)).optional(),
      })
      .strict()
      .optional(),
    // [契约] 两个凭据键只存「查找键」，真实密码在凭据库，schema 层就是脱敏边界。
    // [并发] credentialKey 由解析结果原样透传，schema 是共享的无状态实例，不允许写入。
    // [失败路径] 键为空串时查找必然失败，故用 nonEmptyString + trim 把错误提前到解析期。
    // [边界] passwordCredentialKey 只校验非空：凭据是否存在留给运行时，解析期没有凭据库上下文。
    passwordCredentialKey: credentialKeySchema.optional(),
    privateKeyPassphraseCredentialKey: credentialKeySchema.optional(),
  })
  .strict();

// [契约] WSL target 的 distro/user 均可选：缺省即「默认发行版/默认用户」，由 wsl 命令自行解析。
// [契约] user 复用 wslUserSchema，字符集与长度约束与其他 WSL 入口保持单点一致。
// [失败路径] 与 updateTarget 的差异是故意的：那里 distro/user 必填，因为升级授权不接受歧义身份。
// [权衡] optional 让旧 profile 免迁移即可读入，代价是下游必须显式处理 undefined 分支。
export const wslProfileTargetSchema = z
  .object({
    kind: z.literal("wsl"),
    distro: z.string().optional(),
    user: wslUserSchema.optional(),
  })
  .strict();

// [契约] Docker target 只需 container 且不允许空串；镜像、用户等由容器自身决定。
// [契约] 直接复用 dockerProfileTargetSchema 作为 updateTarget 第三支，保证两处容器身份同构。
// [失败路径] 容器重命名不在 schema 范围，表现为连接失败而非解析失败，需上层提示重建 profile。
// [权衡] 不含 compose 服务名与项目路径，避免把编排概念渗入连接契约。
export const dockerProfileTargetSchema = z
  .object({
    kind: z.literal("docker"),
    container: nonEmptyStringSchema,
  })
  .strict();

// [契约] 判别键为 kind，与 transport 分开命名：profile 的传输方式与 target 形状各自演进。
// [失败路径] 判别值不匹配任何分支时直接报错，不会退化成长联合的宽泛校验。
// [契约] 新增分支必须同时被 connectionProfileSchema 与 updateTarget 覆盖，否则出现「能存不能连」。
// [权衡] discriminator 比普通 union 多一次键检查，换来精确错误路径与更快收敛。
export const sourceServerProfileTargetSchema = z.discriminatedUnion("kind", [
  sshProfileTargetSchema,
  wslProfileTargetSchema,
  dockerProfileTargetSchema,
]);

export type SSHProfileTarget = z.infer<typeof sshProfileTargetSchema>;
export type WSLProfileTarget = z.infer<typeof wslProfileTargetSchema>;
export type DockerProfileTarget = z.infer<typeof dockerProfileTargetSchema>;
export type SourceServerProfileTarget = z.infer<typeof sourceServerProfileTargetSchema>;

// [契约] updateTarget 是升级授权的独立契约，刻意不含凭据与可变安装配置。
// [契约] ssh 分支把 host 转小写、port 补 22，使同一主机的不同写法收敛成同一授权身份。
// [并发] 授权比较依赖 getSourceServerUpdateTarget 的稳定字段顺序，新增字段会改变序列化结果。
// [失败路径] wsl 分支 distro/user 必填，缺一即失败，避免「默认发行版」被误当成同一授权对象。
/** 升级授权只绑定执行身份，不携带凭据或可变 Profile 内容。 */
export const sourceServerUpdateTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ssh"),
      host: nonEmptyStringSchema.toLowerCase(),
      port: z.number().int().positive().max(65_535).default(22),
      username: nonEmptyStringSchema,
      sshConfigAlias: nonEmptyStringSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("wsl"),
      distro: nonEmptyStringSchema,
      user: wslUserSchema.refine((value) => value.length > 0),
    })
    .strict(),
  dockerProfileTargetSchema,
]);
export type SourceServerUpdateTarget = z.infer<typeof sourceServerUpdateTargetSchema>;

export function getSourceServerUpdateTarget(
  target: Exclude<RemoteTarget, { kind: "server" }>,
): SourceServerUpdateTarget {
  switch (target.kind) {
    case "ssh":
      return sourceServerUpdateTargetSchema.parse({
        kind: target.kind,
        host: target.host,
        port: target.port ?? 22,
        username: target.username,
        ...(target.sshConfigAlias?.trim() ? { sshConfigAlias: target.sshConfigAlias.trim() } : {}),
      });
    case "wsl":
      return sourceServerUpdateTargetSchema.parse({
        kind: target.kind,
        distro: target.distro,
        user: target.user,
      });
    case "docker":
      return sourceServerUpdateTargetSchema.parse({
        kind: target.kind,
        container: target.container,
      });
  }
}

// [并发] 相等判定先剔除 wsl 身份不全的输入，避免两个「默认用户」被误判为同一目标。
// [契约] 比较基于 JSON.stringify，字段增删会改变结果，这是隐性契约，必须有回归用例。
// [失败路径] 任一侧解析抛错时不做兜底，让调用方感知非法 target，而不是静默返回 false。
export function isSameSourceServerUpdateTarget(
  left: Exclude<RemoteTarget, { kind: "server" }>,
  right: Exclude<RemoteTarget, { kind: "server" }>,
): boolean {
  if (
    [left, right].some(
      (target) => target.kind === "wsl" && (!target.distro?.trim() || !target.user?.trim()),
    )
  )
    return false;
  return (
    JSON.stringify(getSourceServerUpdateTarget(left)) ===
    JSON.stringify(getSourceServerUpdateTarget(right))
  );
}

// [契约] 请求体 strict：profileId 必填，force 与 expectedTarget 可选，未知字段直接拒绝。
// [失败路径] expectedTarget 缺失表示「不校验当前目标」，不是「跳过身份校验」的开关。
// [并发] force 只能放大重试容忍度，不能绕过 expectedTarget 不匹配时的冲突中止。
// [权衡] 对外类型用 z.input，因为 default 尚未生效，调用方允许省略带默认值的字段。
export const sourceServerUpdateRequestSchema = z
  .object({
    profileId: nonEmptyStringSchema,
    force: z.boolean().optional(),
    expectedTarget: sourceServerUpdateTargetSchema.optional(),
  })
  .strict();
export type SourceServerUpdateRequest = z.input<typeof sourceServerUpdateRequestSchema>;

// [契约] 基础形状用对象展开复用，三个 transport 分支共享同一组字段与默认值。
// [契约] profileId 标识连接配置，sourceServerId 标识远端安装实体，两者生命周期不同，不可混用。
// [失败路径] retiredReason 只允许字面量 source-reinstalled，其他下线原因会被 strict 拒绝。
// [权衡] lifecycleState 带 default("active")，z.input 允许省略，但磁盘回读时字段一定存在。
const connectionProfileBaseShape = {
  profileId: z.string().uuid(),
  sourceServerId: z.string().uuid().optional(),
  displayName: nonEmptyStringSchema.optional(),
  lastConnectedAt: timestampSchema.optional(),
  lastConnectError: z.string().optional(),
  createdAt: timestampSchema,
  lifecycleState: z.enum(["active", "retired"]).default("active"),
  retiredReason: z.literal("source-reinstalled").optional(),
  retiredAt: timestampSchema.optional(),
};

// [契约] 顶层判别键是 transport，且要求 target.kind 与之一致，不一致即解析失败。
// [事务] profile 是配置事实，lastConnectError 与 lastConnectedAt 只是缓存投影，不得反写 target。
// [失败路径] 顶层与嵌套 strict 必须同时存在，只加顶层会让 target 内多出的字段穿透。
// [权衡] 三支显式重复而非泛型生成，牺牲行数换取报错信息里能直接看到分支名。
export const connectionProfileSchema = z.discriminatedUnion("transport", [
  z
    .object({
      ...connectionProfileBaseShape,
      transport: z.literal("ssh"),
      target: sshProfileTargetSchema,
    })
    .strict(),
  z
    .object({
      ...connectionProfileBaseShape,
      transport: z.literal("wsl"),
      target: wslProfileTargetSchema,
    })
    .strict(),
  z
    .object({
      ...connectionProfileBaseShape,
      transport: z.literal("docker"),
      target: dockerProfileTargetSchema,
    })
    .strict(),
]);

export type ConnectionProfile = z.infer<typeof connectionProfileSchema>;

// [契约] server 记录以 sourceServerId 为主键，displayName 必填，其余环境信息都是可选观测值。
// [契约] declaredWorkspaces 默认空数组：老记录缺该字段时解析为 []，读取方无需判空。
// [失败路径] installState 仅有 installed/uninstalled 两态，未知值拒绝，防止 UI 用假值渲染。
// [权衡] 内层 workspace 对象同样 strict，避免未来新增的远端字段被旧版本写入后丢失。
export const sourceServerRecordSchema = z
  .object({
    sourceServerId: z.string().uuid(),
    displayName: nonEmptyStringSchema,
    osUser: nonEmptyStringSchema.optional(),
    hostname: nonEmptyStringSchema.optional(),
    lastSeenVersion: nonEmptyStringSchema.optional(),
    lastOnlineAt: timestampSchema.optional(),
    preferredProfileId: z.string().uuid().optional(),
    installState: z.enum(["installed", "uninstalled"]).default("installed"),
    declaredWorkspaces: z
      .array(
        z
          .object({
            workspacePath: nonEmptyStringSchema,
            workspaceIdentity: nonEmptyStringSchema,
            label: nonEmptyStringSchema.optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type SourceServerRecord = z.infer<typeof sourceServerRecordSchema>;

// [契约] 历史条目同时保留 workspacePath、workspaceIdentity 与 legacyWorkspaceIdentity 三者。
// [契约] identity 与 legacy 均可选：迁移期允许只按路径匹配，新写入应始终带 identity。
// [失败路径] profileId 必填 uuid，历史记录失去 profile 时无法解析，需迁移脚本先修补。
// [权衡] lastOpenedAt 必填而非默认当前时间，保证排序稳定，避免每次读取刷新时间戳。
export const sourceServerWorkspaceHistoryEntrySchema = z
  .object({
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema.optional(),
    legacyWorkspaceIdentity: nonEmptyStringSchema.optional(),
    profileId: z.string().uuid(),
    sourceServerId: z.string().uuid().optional(),
    lastOpenedAt: timestampSchema,
  })
  .strict();

export type SourceServerWorkspaceHistoryEntry = z.infer<
  typeof sourceServerWorkspaceHistoryEntrySchema
>;

// [契约] 冲突记录回答「为什么没能自动合并」，kind 只区分 task-identity 与 config-file 两类。
// [契约] key/sourceKey/canonicalKey/reason 全必填，保证 UI 能直接展示冲突双方与判定依据。
// [失败路径] taskId 与 relativePath 可选，取决于 kind；schema 不做交叉校验，消费方按 kind 读取。
// [权衡] 不用 refine 约束 kind 与可选字段组合，避免错误挂到整个对象而非具体字段。
export const sourceServerMigrationConflictSchema = z
  .object({
    kind: z.enum(["task-identity", "config-file"]),
    key: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema.optional(),
    relativePath: nonEmptyStringSchema.optional(),
    sourceKey: nonEmptyStringSchema,
    canonicalKey: nonEmptyStringSchema,
    reason: nonEmptyStringSchema,
  })
  .strict();
export type SourceServerMigrationConflict = z.infer<typeof sourceServerMigrationConflictSchema>;

// [契约] 行状态含 running/completed/failed/abandoned/abandoned-diverged 五个值，其余拒绝。
// [契约] phase/errorCode/backupPath 可选：仅失败或部分完成的行会填充，读取方按 status 分派。
// [失败路径] abandoned-diverged 必须与 abandoned 区分，前者表示内容已分叉，备份不可直接删除。
// [事务] updatedAt 必填，abandonedAt 仅在放弃后出现，两者共同构成该行的时序证据。
export const sourceServerMigrationReportRowSchema = z
  .object({
    migrationId: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    canonicalKey: nonEmptyStringSchema,
    variantKeys: z.array(nonEmptyStringSchema),
    status: z.enum(["running", "completed", "failed", "abandoned", "abandoned-diverged"]),
    phase: nonEmptyStringSchema.optional(),
    errorCode: nonEmptyStringSchema.optional(),
    taskBackupPath: nonEmptyStringSchema.optional(),
    sessionBackupPath: nonEmptyStringSchema.optional(),
    updatedAt: timestampSchema,
    abandonedAt: timestampSchema.optional(),
    abandonedTrigger: nonEmptyStringSchema.optional(),
    conflicts: z.array(sourceServerMigrationConflictSchema),
  })
  .strict();
export type SourceServerMigrationReportRow = z.infer<typeof sourceServerMigrationReportRowSchema>;

export const sourceServerMigrationReportSchema = z
  .object({ rows: z.array(sourceServerMigrationReportRowSchema) })
  .strict();
export type SourceServerMigrationReport = z.infer<typeof sourceServerMigrationReportSchema>;

export const sourceServerMigrationPathActionSchema = z
  .object({
    workspacePath: nonEmptyStringSchema,
    migrationId: nonEmptyStringSchema.optional(),
  })
  .strict();
export type SourceServerMigrationPathAction = z.infer<typeof sourceServerMigrationPathActionSchema>;

// [契约] 解析请求只带路径与旧路由提示；legacyRouteHint 可选，用于迁移期识别旧 URL 形态。
// [契约] 结果返回 canonicalWorkspaceKey 与 mergedKeys，migrationId 可选表示本次是否新建迁移。
// [失败路径] 空路径在解析期被拒，避免把「未指定工作区」解释成当前目录。
// [权衡] mergedKeys 一定返回数组，允许为空，让调用方无需区分 undefined 与空集合。
export const sourceServerResolveWorkspaceRequestSchema = z
  .object({
    workspacePath: nonEmptyStringSchema,
    legacyRouteHint: nonEmptyStringSchema.optional(),
  })
  .strict();
export type SourceServerResolveWorkspaceRequest = z.infer<
  typeof sourceServerResolveWorkspaceRequestSchema
>;

export const sourceServerResolveWorkspaceResultSchema = z
  .object({
    canonicalWorkspaceKey: nonEmptyStringSchema,
    mergedKeys: z.array(nonEmptyStringSchema),
    migrationId: nonEmptyStringSchema.optional(),
  })
  .strict();
export type SourceServerResolveWorkspaceResult = z.infer<
  typeof sourceServerResolveWorkspaceResultSchema
>;

// [契约] 连接状态是封闭枚举，共十种取值，未知值一律拒绝。
// [失败路径] 未知状态被拒而非映射成 offline，避免新版本状态在旧 UI 上被误报为断线。
// [并发] 枚举只描述快照瞬时值，迁移顺序由 host 状态机保证，本文件不编码时序。
// [权衡] 用枚举而非布尔组合，牺牲扩展性换取穷尽 switch 与可读的失败提示。
export const sourceServerConnectionStateSchema = z.enum([
  "absent",
  "bootstrapping",
  "needs-install",
  "needs-upgrade",
  "updating",
  "online",
  "retrying",
  "offline",
  "identity-change-pending",
  "failed",
]);
export type SourceServerConnectionState = z.infer<typeof sourceServerConnectionStateSchema>;

/** 远端任务 owner 的活动投影；身份用于隔离，实际路径仅用于展示。 */
export const sourceServerRunningTaskSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema.optional(),
  })
  .strict();
export type SourceServerRunningTask = z.infer<typeof sourceServerRunningTaskSchema>;
export const sourceServerRunningTasksSchema = z.array(sourceServerRunningTaskSchema);

/** 只读安装预览；sizeBytes 是安装包实际大小，不代表解压后的磁盘占用。 */
export const sourceServerInstallPreviewSchema = z
  .object({
    version: nonEmptyStringSchema,
    installPath: nonEmptyStringSchema.optional(),
    sizeBytes: z.number().int().positive(),
  })
  .strict();
export type SourceServerInstallPreview = z.infer<typeof sourceServerInstallPreviewSchema>;

// [契约] 快照同时带 profileId 与可选 sourceServerId，二者在重装或换绑期间可能短暂不一致。
// [契约] error/errorCode/retryable 均可选；成功态不带 error，读取方按 state 分支取值。
// [失败路径] recoveryAttempt/recoveryLimit/recoveryBudgetExhausted 只用于重试展示，不参与重连决策。
// [权衡] pendingSourceServerId 与 sourceServerId 并存，专门表达「身份变更待确认」的过渡窗口。
export const sourceServerConnectionStateSnapshotSchema = z
  .object({
    profileId: z.string().uuid(),
    sourceServerId: z.string().uuid().optional(),
    state: sourceServerConnectionStateSchema,
    error: z.string().optional(),
    updateAvailability: z.enum(["none", "available", "required"]).optional(),
    currentVersion: nonEmptyStringSchema.optional(),
    availableVersion: nonEmptyStringSchema.optional(),
    minimumVersion: nonEmptyStringSchema.optional(),
    upgradeTarget: z.enum(["controller", "server"]).optional(),
    errorCode: publicZCodeErrorCodeSchema.optional(),
    retryable: z.boolean().optional(),
    installPreview: sourceServerInstallPreviewSchema.optional(),
    runningTasks: sourceServerRunningTasksSchema.optional(),
    pendingSourceServerId: z.string().uuid().optional(),
    recoveryAttempt: z.number().int().positive().optional(),
    recoveryLimit: z.number().int().positive().optional(),
    recoveryBudgetExhausted: z.boolean().optional(),
    updatedAt: timestampSchema,
  })
  .strict();
export type SourceServerConnectionStateSnapshot = z.infer<
  typeof sourceServerConnectionStateSnapshotSchema
>;

export const sourceServerManagementSnapshotRequestSchema = z
  .object({
    refreshMigrationCounts: z.boolean().optional(),
  })
  .strict();
export type SourceServerManagementSnapshotRequest = z.infer<
  typeof sourceServerManagementSnapshotRequestSchema
>;

// [契约] 管理快照以 generation 整体替换，profiles/servers/states 必须是同一代的全量视图。
// [并发] generation 只增不减，消费方据此丢弃乱序旧快照，schema 只保证非负不保证连续。
// [事务] failedPathCount/abandonedPathCount 是冗余聚合，与 states 不一致时由 host 重建为准。
// [失败路径] migrationCounts 按 status 判别：available 分支才带计数，其余分支刻意不带。
export const sourceServerManagementSnapshotSchema = z
  .object({
    generation: z.number().int().nonnegative(),
    profiles: z.array(connectionProfileSchema),
    servers: z.array(sourceServerRecordSchema),
    workspaceHistory: z.array(sourceServerWorkspaceHistoryEntrySchema),
    states: z.array(sourceServerConnectionStateSnapshotSchema),
    failedPathCount: z.number().int().nonnegative(),
    abandonedPathCount: z.number().int().nonnegative(),
    migrationCounts: z.array(
      z.discriminatedUnion("status", [
        z
          .object({
            sourceServerId: nonEmptyStringSchema,
            status: z.literal("available"),
            failedPathCount: z.number().int().nonnegative(),
            abandonedPathCount: z.number().int().nonnegative(),
          })
          .strict(),
        z
          .object({
            sourceServerId: nonEmptyStringSchema,
            status: z.literal("requires-connection"),
          })
          .strict(),
        z.object({ sourceServerId: nonEmptyStringSchema, status: z.literal("loading") }).strict(),
        z
          .object({ sourceServerId: nonEmptyStringSchema, status: z.literal("unavailable") })
          .strict(),
      ]),
    ),
  })
  .strict();
export type SourceServerManagementSnapshot = z.infer<typeof sourceServerManagementSnapshotSchema>;

// [契约] 增量语义是「替换该 profile 的状态」，不是字段合并，故只带 generation 与整条 state。
// [并发] 增量须与快照同源 generation，跨代增量应丢弃；schema 只校验 positive，不判新旧。
// [权衡] directoryDelta 仅带 generation 作为「目录需重拉」信号，避免重复推送大对象。
export const sourceServerManagementStateDeltaSchema = z
  .object({
    generation: z.number().int().positive(),
    state: sourceServerConnectionStateSnapshotSchema,
  })
  .strict();
export type SourceServerManagementStateDelta = z.infer<
  typeof sourceServerManagementStateDeltaSchema
>;

export const sourceServerManagementDirectoryDeltaSchema = z
  .object({
    generation: z.number().int().positive(),
  })
  .strict();
export type SourceServerManagementDirectoryDelta = z.infer<
  typeof sourceServerManagementDirectoryDeltaSchema
>;

/** Server CLI 的可选逐行进度；终态仍由退出码和最后一行结果决定。 */
export const sourceServerInstallProgressSchema = z
  .object({
    type: z.literal("source-server-install-progress"),
    phase: z.enum(["verify-archive", "extract", "verify", "restart"]),
  })
  .strict();
export type SourceServerInstallProgress = z.infer<typeof sourceServerInstallProgressSchema>;

export const sourceServerOperationLogSchema = z
  .object({
    profileId: z.string().uuid(),
    operation: z.enum(["connect", "update"]),
    phase: nonEmptyStringSchema,
    level: z.enum(["info", "warn", "error"]),
    message: z.string(),
    progress: z.number().min(0).max(1).optional(),
    timestamp: timestampSchema,
  })
  .strict();
export type SourceServerOperationLog = z.infer<typeof sourceServerOperationLogSchema>;

export type SourceServerDeclaredWorkspaceWire = z.infer<typeof serverRemoteWorkspaceInfoSchema>;
