// INV-01 错误码枚举是跨进程契约，只能追加不能改名：守住位置 错误码 schema；改错故障 旧宿主无法识别新错误。
// INV-02 分类优先使用结构化原因而不是文案：守住位置 classifyDatabaseStartupError 的注释与实现；改错故障 本地化文案变化导致误判。
// INV-03 主错误码取低 8 位：守住位置 位掩码；改错故障 扩展错误码被当成未知。
// INV-04 满盘判定同时接受空间不足与配额超限：守住位置 返回分支；改错故障 配额超限被误判为普通 IO 错误。
// INV-05 权限类错误全并到同一错误码：守住位置 第二分支；改错故障 同类失败出现多种错误码。
// INV-06 遍历原因链必须带环检测与深度上限：守住位置 已见集合与计数上限；改错故障 自引用错误导致死循环。
// INV-07 分类兜底为 SQL 失败而不是未知码：守住位置 兜底初值；改错故障 前端无对应文案。
// INV-08 明细只传错误码与迁移标识：守住位置 明细函数；改错故障 SQL 或凭据泄漏到渲染进程。
// INV-09 系统错误码必须匹配大写枚举形状：守住位置 正则；改错故障 任意字符串被当作系统码。
// INV-10 迁移标识只允许有限字符集：守住位置 两处正则；改错故障 路径注入风险。
// INV-11 明细 schema 与函数输出字段保持一致：守住位置 明细 schema；改错故障 校验与生产脱节。
// INV-12 磁盘摘要必须是严格对象且数值非负：守住位置 严格模式与非负约束；改错故障 负数污染容量展示。
// INV-13 已提交数不得超过已执行数：守住位置 迁移事实的细化校验；改错故障 统计页出现负的待提交量。
// INV-14 无迁移时执行数必须为零：守住位置 同一细化校验；改错故障 空迁移被记成执行过。
// INV-15 启动状态版本号固定为 1：守住位置 字面量校验；改错故障 新旧版本状态互串。
// INV-16 磁盘摘要最多 8 条：守住位置 数组上限；改错故障 异常输入撑爆状态体积。
// INV-17 重试条件必须排除已装配服务后的失败：守住位置 失败阶段判断；改错故障 重试产生重复启动副作用。
// INV-18 损坏与失联类错误不可重试：守住位置 错误码排除列表；改错故障 无效重试掩盖真实故障。
//
// 模块职责：定义数据库启动状态的错误码、状态 schema 与可重试判定。
// 状态所有权：全部为纯 schema 与纯函数；启动状态快照由宿主进程持有。
// 阅读顺序：先看错误分类与安全明细，再读各层 schema，最后看重试条件。
import { z } from "zod";

export const databaseStartupErrorCodeSchema = z.enum([
  "storage_full",
  "permission_denied",
  "io_error",
  "out_of_memory",
  "corrupt",
  "open_failed",
  "lock_timeout",
  "checksum_mismatch",
  "sql_failed",
  "startup_status_timeout",
  "transport_closed",
  "unsupported_runtime",
]);
export type DatabaseStartupErrorCode = z.infer<typeof databaseStartupErrorCodeSchema>;

/** 原始结构化 cause 比外层通用包装更准确；禁止从错误文案推断满盘或 OOM。 */
// classifyDatabaseStartupError 从最外层 error 开始逐层读 cause。
// 每层先看 value.errcode 主码，再看 value.code 系统错误码。
// 可恢复映射写入 fallback，强特征直接 return。
// kind 枚举只作为 fallback 证据。
// while 循环带 seen 环检测与 12 次上限。
// 最终 return fallback，不抛异常。
export function classifyDatabaseStartupError(error: unknown): DatabaseStartupErrorCode {
  const seen = new Set<unknown>();
  let fallback: DatabaseStartupErrorCode = "sql_failed";
  while (error && typeof error === "object" && !seen.has(error) && seen.size < 12) {
    seen.add(error);
    const value = error as { code?: unknown; errcode?: unknown; kind?: unknown; cause?: unknown };
    const primary = typeof value.errcode === "number" ? value.errcode & 0xff : undefined;
    if (primary === 13 || value.code === "ENOSPC" || value.code === "EDQUOT") return "storage_full";
    if (primary === 3 || primary === 8 || value.code === "EACCES" || value.code === "EPERM")
      return "permission_denied";
    if (primary === 10 || value.code === "EIO") return "io_error";
    if (primary === 7 || value.code === "ENOMEM" || value.code === "ERR_WORKER_OUT_OF_MEMORY")
      return "out_of_memory";
    if (primary === 11 || primary === 26) return "corrupt";
    if (primary === 14) fallback = "open_failed";
    if (primary === 5) fallback = "lock_timeout";
    const kind = databaseStartupErrorCodeSchema.safeParse(value.kind);
    if (kind.success && kind.data !== "sql_failed") fallback = kind.data;
    error = value.cause;
  }
  return fallback;
}

/** 只跨进程传输错误码和冻结迁移 ID，不携带 SQL、文件内容或凭据。 */
// databaseStartupErrorDetails 只提取三个可跨进程字段。
// sqliteCode 要求 Number.isSafeInteger。
// systemCode 限制为大写枚举形状。
// migrationId 限制字符集与长度。
// 其余字段一律不进 result。
export function databaseStartupErrorDetails(error: unknown): {
  sqliteCode?: number;
  systemCode?: string;
  migrationId?: string;
} {
  const result: { sqliteCode?: number; systemCode?: string; migrationId?: string } = {};
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error) && seen.size < 12) {
    seen.add(error);
    const current = error as {
      errcode?: unknown;
      code?: unknown;
      migrationId?: unknown;
      cause?: unknown;
    };
    if (typeof current.errcode === "number" && Number.isSafeInteger(current.errcode))
      result.sqliteCode = current.errcode;
    if (typeof current.code === "string" && /^[A-Z_0-9]{1,64}$/.test(current.code))
      result.systemCode = current.code;
    if (
      typeof current.migrationId === "string" &&
      /^[a-zA-Z_0-9-]{1,128}$/.test(current.migrationId)
    )
      result.migrationId = current.migrationId;
    error = current.cause;
  }
  return result;
}
export const databaseStartupErrorDetailsSchema = z.object({
  sqliteCode: z.number().int().optional(),
  systemCode: z.string().max(64).optional(),
  migrationId: z.string().max(128).optional(),
});

export const startupDiskSummarySchema = z
  .object({
    scopeId: z.string().max(128),
    observedAvailableDropPeakBytes: z.number().finite().nonnegative().nullable(),
    minAvailableBytes: z.number().finite().nonnegative().nullable(),
    quality: z.enum(["complete", "partial", "unknown"]),
    sampledAt: z.number().finite().nonnegative().nullable(),
  })
  .strict();
export type StartupDiskSummary = z.infer<typeof startupDiskSummarySchema>;
export const databaseStartupPhaseSchema = z.enum([
  "starting",
  "preparing_host_storage",
  "preparing_session_storage",
  "starting_services",
  "ready",
  "failed",
]);
export const databaseMigrationIdSchema = z.string().regex(/^[a-zA-Z_0-9-]{1,128}$/);

/** 需求种类与真实执行/提交分开；预检发现需求不意味着当前执行者运行过 SQL。 */
export const databaseMigrationFactsSchema = z
  .object({
    kind: z.enum(["none", "initialize", "upgrade"]),
    executedCount: z.number().int().nonnegative(),
    committedCount: z.number().int().nonnegative(),
    // null 表示锁内账本为空；缺失表示尚未取得可信起点。
    lastAppliedMigrationId: databaseMigrationIdSchema.nullable().optional(),
  })
  .strict()
  .superRefine((facts, context) => {
    if (
      facts.committedCount > facts.executedCount ||
      (facts.kind === "none" && facts.executedCount !== 0)
    )
      context.addIssue({ code: "custom", message: "Invalid migration execution facts" });
  });
export type DatabaseMigrationFacts = z.infer<typeof databaseMigrationFactsSchema>;

// schemaVersion 用 z.literal(1) 固定版本。
// startup 阶段与 database 阶段分开表达。
// migrationFacts 同时保留当前值与基线。
// disk 摘要限制条数。
// 错误明细字段直接展开复用同一 schema。
export const databaseStartupStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    startupId: z.string().min(1).max(128),
    attemptId: z.string().min(1).max(128),
    sequence: z.number().int().nonnegative(),
    startedAt: z.number().finite().nonnegative(),
    updatedAt: z.number().finite().nonnegative(),
    phase: databaseStartupPhaseSchema,
    databasePhase: z
      .enum(["checking", "waiting_for_lock", "migrating", "committing", "maintaining", "ready"])
      .optional(),
    migration: databaseMigrationFactsSchema.optional(),
    currentMigration: databaseMigrationFactsSchema.optional(),
    migrationBaselines: z
      .array(
        z
          .object({
            databaseId: z.string().min(1).max(128),
            databaseKind: z.enum(["tasks-index", "session"]),
            lastAppliedMigrationId: databaseMigrationIdSchema.nullable().optional(),
          })
          .strict(),
      )
      .optional(),
    finalDatabase: z.boolean().optional(),
    failedPhase: databaseStartupPhaseSchema.optional(),
    errorCode: databaseStartupErrorCodeSchema.optional(),
    ...databaseStartupErrorDetailsSchema.shape,
    disk: z.array(startupDiskSummarySchema).max(8),
  })
  .strict();
export type DatabaseStartupState = z.infer<typeof databaseStartupStateSchema>;
/** 本地端口和启动快照必须来自同一 Host；此 ID 不承担工作区或任务身份。 */
export const databaseStartupPortPayloadSchema = z
  .object({
    databaseStartupId: z.string().min(1).max(128),
  })
  .strict();
// 快照与退出不接受额外字段。
// 重试必须携带新的尝试标识。
// 判别字段固定为 action。
// 未知动作直接校验失败。
export const databaseStartupControlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("snapshot") }).strict(),
  z.object({ action: z.literal("exit") }).strict(),
  z.object({ action: z.literal("retry"), attemptId: z.string().min(1).max(128) }).strict(),
]);
export type DatabaseStartupControl = z.infer<typeof databaseStartupControlSchema>;

/** 迁移可手动重试；已部分装配服务或损坏/失联时通过退出重开恢复，避免重复启动副作用。 */
// canRetryDatabaseStartup 只对 phase === "failed" 生效。
// 已进入服务装配阶段后必须走 exit 重开。
// corrupt 与 transport_closed 以及校验失败都不可重试。
// 其余 errorCode 允许手动重试。
export function canRetryDatabaseStartup(
  state: Pick<DatabaseStartupState, "phase" | "failedPhase" | "errorCode">,
): boolean {
  return (
    state.phase === "failed" &&
    state.failedPhase !== "starting_services" &&
    ![
      "corrupt",
      "checksum_mismatch",
      "transport_closed",
      "startup_status_timeout",
      "unsupported_runtime",
    ].includes(state.errorCode ?? "sql_failed")
  );
}
