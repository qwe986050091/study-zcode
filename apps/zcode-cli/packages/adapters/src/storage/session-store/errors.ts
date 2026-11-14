// ============================================================
// Session store migration errors
// ============================================================
// 定位：session store 打开/迁移阶段的结构化错误类型，供 CLI 入口按 kind
// 区分「checksum 不匹配 / 锁超时 / schema 不兼容」等，而不是靠错误文本判断。
// 输入输出：kind 复用 @zcode/shared 的 DatabaseStartupErrorCode；dbPath 与
// 可选的 migrationId 描述失败位置。
// 副作用：无；只承载 cause 与只读字段。
// 失败语义：本类只被抛出，不吞错；cause 保留底层 SQLite/IO 错误。
// 不变量：name 固定为 SqliteSessionMigrationError，便于日志与序列化识别。

import type { DatabaseStartupErrorCode } from "@zcode/shared";
export type SqliteSessionMigrationErrorKind = DatabaseStartupErrorCode;

export interface SqliteSessionMigrationErrorOptions {
  /** 底层原因（SQLite 错误、checksum 期望/实际等），用于日志与诊断。 */
  cause?: unknown;
  /** 出问题的数据库绝对路径。 */
  dbPath: string;
  /** 失败类别，决定上层是提示用户、锁等待重试还是直接失败。 */
  kind: SqliteSessionMigrationErrorKind;
  /** 具体迁移 id（如 0020）；非迁移阶段失败时缺省。 */
  migrationId?: string;
}

// 迁移失败的标准错误：调用方按 kind 分支处理，禁止解析 message 文本。
export class SqliteSessionMigrationError extends Error {
  readonly dbPath: string;
  readonly kind: SqliteSessionMigrationErrorKind;
  readonly migrationId?: string;

  constructor(message: string, options: SqliteSessionMigrationErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "SqliteSessionMigrationError";
    this.dbPath = options.dbPath;
    this.kind = options.kind;
    this.migrationId = options.migrationId;
  }
}
